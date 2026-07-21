import { bytesOf, exactKeys, isRecord, nonempty } from "./codec.ts";
import { type Digest, digestBytes, digestValue } from "./digest.ts";

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
  readonly rationale?: string;
  readonly supersedes?: string;
}

export interface VerificationAuthorityPort {
  capture: (input: {
    readonly checkpointId: string;
    readonly supersedes?: string;
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
      const checkpoint = this.checkpoint(id, captured);
      this.checkpoints.set(id, checkpoint);
      this.evidenceHistory.add(captured.digest);
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
      const captured = await this.capture(id, previousId);
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
      if (this.evidenceHistory.has(captured.digest)) {
        return {
          status: "rejected",
          code: "SUPERSESSION_REQUIRES_NEW_EVIDENCE",
        };
      }
      const checkpoint = this.checkpoint(id, captured, previousId, rationale);
      this.checkpoints.set(id, checkpoint);
      this.evidenceHistory.add(captured.digest);
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
    const current = await this.capture(input.id, checkpoint.supersedes);
    if (current === undefined) {
      return { status: "invalid", code: "VERIFICATION_AUTHORITY_REJECTED" };
    }
    if (current.evidence.treeDigest !== checkpoint.evidence.treeDigest) {
      return { status: "invalid", code: "TREE_DRIFT" };
    }
    if (current.digest !== checkpoint.evidenceDigest) {
      return { status: "invalid", code: "VERIFIER_DRIFT" };
    }
    return { status: "valid" };
  }

  private checkpoint(
    id: string,
    captured: CapturedEvidence,
    supersedes?: string,
    rationale?: string,
  ): VerifiedCheckpoint {
    return Object.freeze({
      id,
      evidence: captured.evidence,
      evidenceDigest: captured.digest,
      ...(rationale === undefined ? {} : { rationale }),
      ...(supersedes === undefined ? {} : { supersedes }),
    });
  }

  private async capture(
    checkpointId: string,
    supersedes?: string,
  ): Promise<CapturedEvidence | undefined> {
    let raw: unknown;
    try {
      raw = await this.authority.capture(
        Object.freeze({
          checkpointId,
          ...(supersedes === undefined ? {} : { supersedes }),
        }),
      );
    } catch {
      return;
    }
    return parseEvidence(raw);
  }
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
