import { isNormalizedRequest } from "./admission/intent.ts";
import { isRepositoryContext } from "./admission/repository.ts";
import { bytesOf, exactKeys, isRecord, nonempty } from "./codec.ts";
import { type Digest, digestBytes, digestValue } from "./digest.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const taskRestorationReceipts = new WeakSet<object>();

export interface VerificationRun {
  readonly commandBytes: readonly number[];
  readonly commandDigest: Digest;
  readonly outputBytes: readonly number[];
  readonly outputDigest: Digest;
  readonly exitCode: 0;
}

export interface CheckpointEvidence {
  readonly treeBytes: readonly number[];
  readonly treeDigest: Digest;
  readonly compiler: VerificationRun;
  readonly tests: VerificationRun;
  readonly verifier: VerificationRun;
}

export interface VerifiedCheckpoint {
  readonly id: string;
  readonly evidence: CheckpointEvidence;
  readonly evidenceDigest: Digest;
  readonly taskScope: TaskCheckpointScope | null;
  readonly rationale?: string;
  readonly supersedes?: string;
}

export interface TaskCheckpointScope {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly requestDigest: Digest;
  readonly repositoryTreeDigest: Digest;
  readonly contextDigest: Digest;
  readonly scopeDigest: Digest;
}

export interface TaskCheckpointRestorationReceipt {
  readonly checkpointId: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly requestDigest: Digest;
  readonly repositoryTreeDigest: Digest;
  readonly contextDigest: Digest;
  readonly checkpointEvidenceDigest: Digest;
  readonly restorationDigest: Digest;
}

export function isTaskCheckpointRestorationReceipt(
  value: unknown,
): value is TaskCheckpointRestorationReceipt {
  return (
    isRecord(value) &&
    taskRestorationReceipts.has(value) &&
    typeof value["checkpointId"] === "string" &&
    typeof value["taskId"] === "string" &&
    typeof value["repositoryId"] === "string" &&
    typeof value["rootIdentity"] === "string" &&
    validDigest(value["requestDigest"]) &&
    validDigest(value["repositoryTreeDigest"]) &&
    validDigest(value["contextDigest"]) &&
    validDigest(value["checkpointEvidenceDigest"]) &&
    validDigest(value["restorationDigest"])
  );
}

export interface VerificationAuthorityPort {
  capture: (input: {
    readonly checkpointId: string;
    readonly supersedes?: string;
    readonly taskScope?: TaskCheckpointScope;
  }) => unknown | Promise<unknown>;
}

export type CheckpointResult =
  | { readonly status: "accepted"; readonly checkpoint: VerifiedCheckpoint }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_CHECKPOINT_INPUT"
        | "VERIFICATION_AUTHORITY_REJECTED"
        | "CHECKPOINT_EXISTS"
        | "CHECKPOINT_NOT_FOUND"
        | "CHECKPOINT_SUPERSEDED"
        | "CHECKPOINT_OPERATION_IN_PROGRESS"
        | "INVALID_SUPERSESSION_RATIONALE"
        | "SUPERSESSION_REQUIRES_NEW_EVIDENCE";
    };

export type CheckpointValidation =
  | { readonly status: "valid" }
  | {
      readonly status: "invalid";
      readonly code:
        | "INVALID_CHECKPOINT_INPUT"
        | "VERIFICATION_AUTHORITY_REJECTED"
        | "CHECKPOINT_NOT_FOUND"
        | "CHECKPOINT_SUPERSEDED"
        | "TREE_DRIFT"
        | "VERIFIER_DRIFT";
    };

export type TaskCheckpointRestoration =
  | {
      readonly status: "restored";
      readonly receipt: TaskCheckpointRestorationReceipt;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_CHECKPOINT_INPUT"
        | "CHECKPOINT_NOT_FOUND"
        | "CHECKPOINT_SUPERSEDED"
        | "CHECKPOINT_SCOPE_MISMATCH"
        | "TREE_DRIFT"
        | "VERIFIER_DRIFT"
        | "VERIFICATION_AUTHORITY_REJECTED";
    };

interface CapturedEvidence {
  readonly evidence: CheckpointEvidence;
  readonly digest: Digest;
}

export class CheckpointLedger {
  private readonly checkpoints = new Map<string, VerifiedCheckpoint>();
  private readonly superseded = new Set<string>();
  private readonly evidenceHistory = new Set<Digest>();
  private readonly reservedIds = new Set<string>();
  private readonly reservedPreviousIds = new Set<string>();
  private readonly authority: VerificationAuthorityPort;

  constructor(authority: VerificationAuthorityPort) {
    this.authority = authority;
  }

  async create(input: unknown): Promise<CheckpointResult> {
    if (
      !(isRecord(input) && exactKeys(input, ["id"]) && nonempty(input.id, 128))
    ) {
      return { status: "rejected", code: "INVALID_CHECKPOINT_INPUT" };
    }
    const id = input.id;
    if (this.checkpoints.has(id)) {
      return { status: "rejected", code: "CHECKPOINT_EXISTS" };
    }
    if (this.reservedIds.has(id)) {
      return { status: "rejected", code: "CHECKPOINT_OPERATION_IN_PROGRESS" };
    }
    this.reservedIds.add(id);
    try {
      const captured = await this.capture(id);
      if (captured === undefined) {
        return { status: "rejected", code: "VERIFICATION_AUTHORITY_REJECTED" };
      }
      if (this.checkpoints.has(id)) {
        return { status: "rejected", code: "CHECKPOINT_EXISTS" };
      }
      if (this.evidenceHistory.has(captured.digest)) {
        return {
          status: "rejected",
          code: "SUPERSESSION_REQUIRES_NEW_EVIDENCE",
        };
      }
      const checkpoint = this.checkpoint(id, captured, null);
      this.checkpoints.set(id, checkpoint);
      this.evidenceHistory.add(captured.digest);
      return { status: "accepted", checkpoint };
    } finally {
      this.reservedIds.delete(id);
    }
  }

  async createTask(input: unknown): Promise<CheckpointResult> {
    const parsed = parseTaskCheckpointInput(input);
    if (parsed === undefined) {
      return { status: "rejected", code: "INVALID_CHECKPOINT_INPUT" };
    }
    const { id, scope } = parsed;
    if (this.checkpoints.has(id)) {
      return { status: "rejected", code: "CHECKPOINT_EXISTS" };
    }
    if (this.reservedIds.has(id)) {
      return { status: "rejected", code: "CHECKPOINT_OPERATION_IN_PROGRESS" };
    }
    this.reservedIds.add(id);
    try {
      const captured = await this.capture(id, undefined, scope);
      if (captured === undefined) {
        return { status: "rejected", code: "VERIFICATION_AUTHORITY_REJECTED" };
      }
      if (this.checkpoints.has(id)) {
        return { status: "rejected", code: "CHECKPOINT_EXISTS" };
      }
      const evidenceDigest = checkpointDigest(captured.digest, scope);
      if (this.evidenceHistory.has(evidenceDigest)) {
        return {
          status: "rejected",
          code: "SUPERSESSION_REQUIRES_NEW_EVIDENCE",
        };
      }
      const checkpoint = this.checkpoint(id, captured, scope);
      this.checkpoints.set(id, checkpoint);
      this.evidenceHistory.add(evidenceDigest);
      return { status: "accepted", checkpoint };
    } finally {
      this.reservedIds.delete(id);
    }
  }

  async supersede(input: unknown): Promise<CheckpointResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["previousId", "id", "rationale"]) &&
        nonempty(input.previousId, 128) &&
        nonempty(input.id, 128)
      ) ||
      typeof input.rationale !== "string"
    ) {
      return { status: "rejected", code: "INVALID_CHECKPOINT_INPUT" };
    }
    const previousId = input.previousId;
    const id = input.id;
    const previous = this.checkpoints.get(previousId);
    if (previous === undefined) {
      return { status: "rejected", code: "CHECKPOINT_NOT_FOUND" };
    }
    if (this.superseded.has(previousId)) {
      return { status: "rejected", code: "CHECKPOINT_SUPERSEDED" };
    }
    if (this.checkpoints.has(id)) {
      return { status: "rejected", code: "CHECKPOINT_EXISTS" };
    }
    if (this.reservedPreviousIds.has(previousId) || this.reservedIds.has(id)) {
      return { status: "rejected", code: "CHECKPOINT_OPERATION_IN_PROGRESS" };
    }
    const rationale = input.rationale.trim();
    if (
      rationale.length === 0 ||
      rationale.length > 240 ||
      /[\r\n]/u.test(rationale)
    ) {
      return { status: "rejected", code: "INVALID_SUPERSESSION_RATIONALE" };
    }
    this.reservedPreviousIds.add(previousId);
    this.reservedIds.add(id);
    try {
      const captured = await this.capture(id, previousId, previous.taskScope);
      if (captured === undefined) {
        return { status: "rejected", code: "VERIFICATION_AUTHORITY_REJECTED" };
      }
      if (this.superseded.has(previousId)) {
        return { status: "rejected", code: "CHECKPOINT_SUPERSEDED" };
      }
      if (this.checkpoints.get(previousId) !== previous) {
        return { status: "rejected", code: "CHECKPOINT_NOT_FOUND" };
      }
      if (this.checkpoints.has(id)) {
        return { status: "rejected", code: "CHECKPOINT_EXISTS" };
      }
      const evidenceDigest = checkpointDigest(
        captured.digest,
        previous.taskScope,
      );
      if (this.evidenceHistory.has(evidenceDigest)) {
        return {
          status: "rejected",
          code: "SUPERSESSION_REQUIRES_NEW_EVIDENCE",
        };
      }
      const checkpoint = this.checkpoint(
        id,
        captured,
        previous.taskScope,
        previousId,
        rationale,
      );
      this.checkpoints.set(id, checkpoint);
      this.evidenceHistory.add(evidenceDigest);
      this.superseded.add(previousId);
      return { status: "accepted", checkpoint };
    } finally {
      this.reservedPreviousIds.delete(previousId);
      this.reservedIds.delete(id);
    }
  }

  async validate(input: unknown): Promise<CheckpointValidation> {
    if (
      !(isRecord(input) && exactKeys(input, ["id"]) && nonempty(input.id, 128))
    ) {
      return { status: "invalid", code: "INVALID_CHECKPOINT_INPUT" };
    }
    const checkpoint = this.checkpoints.get(input.id);
    if (checkpoint === undefined) {
      return { status: "invalid", code: "CHECKPOINT_NOT_FOUND" };
    }
    if (this.superseded.has(input.id)) {
      return { status: "invalid", code: "CHECKPOINT_SUPERSEDED" };
    }
    const current = await this.capture(
      input.id,
      checkpoint.supersedes,
      checkpoint.taskScope,
    );
    if (current === undefined) {
      return { status: "invalid", code: "VERIFICATION_AUTHORITY_REJECTED" };
    }
    if (current.evidence.treeDigest !== checkpoint.evidence.treeDigest) {
      return { status: "invalid", code: "TREE_DRIFT" };
    }
    if (
      checkpointDigest(current.digest, checkpoint.taskScope) !==
      checkpoint.evidenceDigest
    ) {
      return { status: "invalid", code: "VERIFIER_DRIFT" };
    }
    return { status: "valid" };
  }

  async restoreTask(input: unknown): Promise<TaskCheckpointRestoration> {
    const parsed = parseTaskCheckpointInput(input);
    if (parsed === undefined) {
      return { status: "rejected", code: "INVALID_CHECKPOINT_INPUT" };
    }
    const checkpoint = this.checkpoints.get(parsed.id);
    if (checkpoint === undefined) {
      return { status: "rejected", code: "CHECKPOINT_NOT_FOUND" };
    }
    if (this.superseded.has(parsed.id)) {
      return { status: "rejected", code: "CHECKPOINT_SUPERSEDED" };
    }
    if (!sameTaskScope(checkpoint.taskScope, parsed.scope)) {
      return { status: "rejected", code: "CHECKPOINT_SCOPE_MISMATCH" };
    }
    const current = await this.capture(
      checkpoint.id,
      checkpoint.supersedes,
      checkpoint.taskScope,
    );
    if (current === undefined) {
      return { status: "rejected", code: "VERIFICATION_AUTHORITY_REJECTED" };
    }
    if (this.checkpoints.get(parsed.id) !== checkpoint) {
      return { status: "rejected", code: "CHECKPOINT_NOT_FOUND" };
    }
    if (this.superseded.has(parsed.id)) {
      return { status: "rejected", code: "CHECKPOINT_SUPERSEDED" };
    }
    if (current.evidence.treeDigest !== checkpoint.evidence.treeDigest) {
      return { status: "rejected", code: "TREE_DRIFT" };
    }
    if (
      checkpointDigest(current.digest, checkpoint.taskScope) !==
      checkpoint.evidenceDigest
    ) {
      return { status: "rejected", code: "VERIFIER_DRIFT" };
    }
    const scope = parsed.scope;
    const material = {
      checkpointId: checkpoint.id,
      taskId: scope.taskId,
      repositoryId: scope.repositoryId,
      rootIdentity: scope.rootIdentity,
      requestDigest: scope.requestDigest,
      repositoryTreeDigest: scope.repositoryTreeDigest,
      contextDigest: scope.contextDigest,
      checkpointEvidenceDigest: checkpoint.evidenceDigest,
    };
    const receipt = Object.freeze({
      ...material,
      restorationDigest: digestValue(material),
    });
    taskRestorationReceipts.add(receipt);
    return {
      status: "restored",
      receipt,
    };
  }

  private checkpoint(
    id: string,
    captured: CapturedEvidence,
    taskScope: TaskCheckpointScope | null,
    supersedes?: string,
    rationale?: string,
  ): VerifiedCheckpoint {
    return Object.freeze({
      id,
      evidence: captured.evidence,
      evidenceDigest: checkpointDigest(captured.digest, taskScope),
      taskScope,
      ...(rationale === undefined ? {} : { rationale }),
      ...(supersedes === undefined ? {} : { supersedes }),
    });
  }

  private async capture(
    checkpointId: string,
    supersedes?: string,
    taskScope?: TaskCheckpointScope | null,
  ): Promise<CapturedEvidence | undefined> {
    let raw: unknown;
    try {
      raw = await this.authority.capture(
        Object.freeze({
          checkpointId,
          ...(supersedes === undefined ? {} : { supersedes }),
          ...(taskScope === undefined || taskScope === null
            ? {}
            : { taskScope }),
        }),
      );
    } catch {
      return;
    }
    return parseEvidence(raw);
  }
}

function parseTaskCheckpointInput(
  input: unknown,
): Readonly<{ id: string; scope: TaskCheckpointScope }> | undefined {
  if (
    !(
      isRecord(input) &&
      exactKeys(input, [
        "id",
        "taskId",
        "rootIdentity",
        "request",
        "repository",
      ]) &&
      nonempty(input.id, 128) &&
      nonempty(input.taskId, 128) &&
      nonempty(input["rootIdentity"], 256) &&
      isNormalizedRequest(input.request) &&
      isRepositoryContext(input.repository) &&
      input.request.intentDigest === input.repository.requestDigest
    )
  ) {
    return;
  }
  const scopeMaterial = {
    taskId: input.taskId,
    repositoryId: input.repository.repositoryId,
    rootIdentity: input["rootIdentity"],
    requestDigest: input.request.intentDigest,
    repositoryTreeDigest: input.repository.treeDigest,
    contextDigest: input.repository.contextDigest,
  };
  return Object.freeze({
    id: input.id,
    scope: Object.freeze({
      ...scopeMaterial,
      scopeDigest: digestValue(scopeMaterial),
    }),
  });
}

function checkpointDigest(
  evidenceDigest: Digest,
  taskScope: TaskCheckpointScope | null,
): Digest {
  if (taskScope === null) return evidenceDigest;
  return digestValue({ evidenceDigest, taskScope });
}

function sameTaskScope(
  left: TaskCheckpointScope | null,
  right: TaskCheckpointScope,
): boolean {
  return left !== null && left.scopeDigest === right.scopeDigest;
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}

function parseEvidence(value: unknown): CapturedEvidence | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, ["treeBytes", "compiler", "tests", "verifier"])
    )
  ) {
    return;
  }
  const treeBytes = bytesOf(value.treeBytes);
  const compiler = parseRun(value.compiler);
  const tests = parseRun(value.tests);
  const verifier = parseRun(value.verifier);
  if (
    treeBytes === undefined ||
    treeBytes.length === 0 ||
    compiler === undefined ||
    tests === undefined ||
    verifier === undefined
  ) {
    return;
  }
  const evidence: CheckpointEvidence = Object.freeze({
    treeBytes,
    treeDigest: digestBytes(Uint8Array.from(treeBytes)),
    compiler,
    tests,
    verifier,
  });
  return Object.freeze({
    evidence,
    digest: digestValue({
      treeDigest: evidence.treeDigest,
      compiler: runDigest(compiler),
      tests: runDigest(tests),
      verifier: runDigest(verifier),
    }),
  });
}

function parseRun(value: unknown): VerificationRun | undefined {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, ["commandBytes", "outputBytes", "exitCode"])
    ) ||
    value.exitCode !== 0
  ) {
    return;
  }
  const commandBytes = bytesOf(value.commandBytes);
  const outputBytes = bytesOf(value.outputBytes);
  if (
    commandBytes === undefined ||
    commandBytes.length === 0 ||
    outputBytes === undefined
  ) {
    return;
  }
  return Object.freeze({
    commandBytes,
    commandDigest: digestBytes(Uint8Array.from(commandBytes)),
    outputBytes,
    outputDigest: digestBytes(Uint8Array.from(outputBytes)),
    exitCode: 0,
  });
}

function runDigest(run: VerificationRun) {
  return {
    commandDigest: run.commandDigest,
    outputDigest: run.outputDigest,
    exitCode: run.exitCode,
  };
}
