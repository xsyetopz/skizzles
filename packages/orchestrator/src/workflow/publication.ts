import { posix } from "node:path";
import {
  isTaskWorktreeReceipt,
  type TaskWorktreeReceipt,
} from "@skizzles/task-worktree";
import type {
  ExpectedSnapshot,
  PostCommitLeaseCleanupFailure,
  PublicationResult,
} from "@skizzles/workspace-transaction";
import { exactKeys, isRecord } from "../codec.ts";
import { digestValue } from "../digest.ts";
import type { RepositoryContext } from "../repository.ts";
import type { TargetBaseline } from "../state/target.ts";
import type {
  CapturedPublicationBaseline,
  PublicationBaselineAuthorityPort,
  PublicationIdentity,
} from "./contract.ts";
import type { WorkflowEngineeringEvidence } from "./evidence.ts";
import { createWorktreeMaterial } from "./worktree/receipt.ts";

const rawDigest = /^[0-9a-f]{64}$/u;
const maximumCandidateBytes = 1_500_000;
const maximumDiffBytes = 4_194_304;

export interface WorkflowTarget {
  readonly path: string;
  readonly operation: "write" | "delete";
  readonly candidateBytes: readonly number[] | null;
}

export interface PreparedPublication {
  readonly reference: string;
  readonly transactionDigest: string;
  readonly request: unknown;
  readonly diffBytes: readonly number[];
  readonly targetCount: number;
  readonly taskWorktreeReceipt: TaskWorktreeReceipt;
}

export function parseWorkflowTargets(
  value: unknown,
): readonly WorkflowTarget[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return;
  const targets: WorkflowTarget[] = [];
  const paths = new Set<string>();
  let totalCandidateBytes = 0;
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate["operation"] !== "string")
      return;
    const writing = candidate["operation"] === "write";
    if (
      !exactKeys(
        candidate,
        ["path", "operation"],
        writing ? ["candidateBytes"] : [],
      )
    )
      return;
    const path = normalizeTarget(candidate["path"]);
    const candidateBytes = writing ? bytes(candidate["candidateBytes"]) : null;
    if (
      path === undefined ||
      paths.has(path) ||
      (writing && candidateBytes === undefined) ||
      (!writing && candidate["operation"] !== "delete")
    )
      return;
    totalCandidateBytes += candidateBytes?.length ?? 0;
    if (totalCandidateBytes > maximumCandidateBytes) return;
    paths.add(path);
    targets.push(
      Object.freeze({
        path,
        operation: writing ? "write" : "delete",
        candidateBytes:
          writing && candidateBytes !== undefined ? candidateBytes : null,
      }),
    );
  }
  targets.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(targets);
}

export async function capturePublicationBaseline(
  authority: PublicationBaselineAuthorityPort,
  baseline: TargetBaseline,
  targets: readonly WorkflowTarget[],
): Promise<CapturedPublicationBaseline | undefined> {
  let raw: unknown;
  try {
    raw = await authority.capture(
      Object.freeze({
        baseline,
        targets: Object.freeze(
          targets.map(({ path, operation }) =>
            Object.freeze({ path, operation }),
          ),
        ),
      }),
    );
  } catch {
    return;
  }
  if (
    !(
      isRecord(raw) &&
      exactKeys(raw, ["baselineDigest", "targets"]) &&
      raw["baselineDigest"] === baseline.baselineDigest &&
      Array.isArray(raw["targets"]) &&
      raw["targets"].length === targets.length
    )
  )
    return;
  const captured: {
    readonly path: string;
    readonly expected: ExpectedSnapshot;
  }[] = [];
  for (const [index, target] of targets.entries()) {
    const candidate = raw["targets"][index];
    if (
      !(
        isRecord(candidate) &&
        exactKeys(candidate, ["path", "expected"]) &&
        candidate["path"] === target.path
      )
    )
      return;
    const expected = parseExpected(candidate["expected"]);
    if (
      expected === undefined ||
      (target.operation === "delete" && expected.state !== "file")
    )
      return;
    captured.push(Object.freeze({ path: target.path, expected }));
  }
  return Object.freeze({
    baselineDigest: baseline.baselineDigest,
    targets: Object.freeze(captured),
  });
}

export async function preparePublication(
  identity: PublicationIdentity,
  repository: RepositoryContext,
  baseline: TargetBaseline,
  captured: CapturedPublicationBaseline,
  targets: readonly WorkflowTarget[],
  taskWorktreeReceipt: TaskWorktreeReceipt,
  executedProfileIds: readonly string[],
  engineeringEvidence: WorkflowEngineeringEvidence | null = null,
): Promise<PreparedPublication | undefined> {
  if (
    repository.repositoryId !== identity.repositoryId ||
    !isTaskWorktreeReceipt(taskWorktreeReceipt)
  )
    return;
  const transactionTargets: unknown[] = [];
  const diffTargets: unknown[] = [];
  let totalBytes = 0;
  for (const [index, target] of targets.entries()) {
    const expected = captured.targets[index]?.expected;
    if (expected === undefined) return;
    if (target.operation === "delete") {
      transactionTargets.push(
        Object.freeze({ path: target.path, operation: "delete", expected }),
      );
      diffTargets.push(
        Object.freeze({ path: target.path, operation: "delete", expected }),
      );
      continue;
    }
    if (target.candidateBytes === null) return;
    const candidateBytes = target.candidateBytes;
    totalBytes += candidateBytes.length;
    if (totalBytes > maximumCandidateBytes) return;
    const frozenBytes = Object.freeze([...candidateBytes]);
    transactionTargets.push(
      Object.freeze({
        path: target.path,
        operation: "write",
        expected,
        candidateBytes: frozenBytes,
      }),
    );
    diffTargets.push(
      Object.freeze({
        path: target.path,
        operation: "write",
        expected,
        candidateBase64: Buffer.from(candidateBytes).toString("base64"),
      }),
    );
  }
  const worktreeMaterial = createWorktreeMaterial(
    taskWorktreeReceipt,
    executedProfileIds,
  );
  const reference = digestValue({
    repositoryId: identity.repositoryId,
    rootIdentity: identity.rootIdentity,
    ownerId: identity.ownerId,
    baselineDigest: baseline.baselineDigest,
    engineeringEvidenceDigest: engineeringEvidence?.evidenceDigest ?? null,
    taskWorktree: worktreeMaterial,
    targets: diffTargets,
  });
  const request = Object.freeze({
    version: 1,
    repositoryId: identity.repositoryId,
    rootIdentity: identity.rootIdentity,
    ownerId: identity.ownerId,
    approvalReference: reference,
    targets: Object.freeze(transactionTargets),
  });
  const diff = new TextEncoder().encode(
    JSON.stringify(
      Object.freeze({
        version: 1,
        taskWorktree: worktreeMaterial,
        engineeringEvidence:
          engineeringEvidence === null
            ? null
            : Object.freeze({
                evidenceDigest: engineeringEvidence.evidenceDigest,
                evidenceBase64: Buffer.from(
                  engineeringEvidence.evidenceBytes,
                ).toString("base64"),
              }),
        targets: diffTargets,
      }),
    ),
  );
  if (diff.byteLength === 0 || diff.byteLength > maximumDiffBytes) return;
  return Object.freeze({
    reference,
    transactionDigest: digestValue(request),
    request,
    diffBytes: Object.freeze(Array.from(diff)),
    targetCount: targets.length,
    taskWorktreeReceipt,
  });
}

export function exactPublicationSuccess(
  value: PublicationResult,
  expectedTargets: number,
): value is Extract<PublicationResult, { readonly ok: true }> {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "ok",
      "status",
      "transactionId",
      "requestDigest",
      "targetSetDigest",
      "baselineDigest",
      "publishedTargets",
    ]) &&
    value["ok"] === true &&
    value["status"] === "committed" &&
    rawDigest.test(
      typeof value["transactionId"] === "string" ? value["transactionId"] : "",
    ) &&
    rawDigest.test(
      typeof value["requestDigest"] === "string" ? value["requestDigest"] : "",
    ) &&
    rawDigest.test(
      typeof value["targetSetDigest"] === "string"
        ? value["targetSetDigest"]
        : "",
    ) &&
    rawDigest.test(
      typeof value["baselineDigest"] === "string"
        ? value["baselineDigest"]
        : "",
    ) &&
    value["publishedTargets"] === expectedTargets
  );
}

export function exactCommittedCleanupFailure(
  value: PublicationResult,
  expectedTargets: number,
): value is PostCommitLeaseCleanupFailure & {
  readonly status: "committed-no-recovery-lease-cleanup-failed";
  readonly recoveryRequired: false;
} {
  if (
    !(
      isRecord(value) &&
      exactKeys(
        value,
        [
          "ok",
          "code",
          "status",
          "message",
          "commitmentSource",
          "publicationCommitted",
          "journalPresent",
          "recoveryRequired",
          "journalState",
          "transactionId",
          "requestDigest",
          "targetSetDigest",
          "baselineDigest",
          "publishedTargets",
          "evidence",
        ],
        ["priorFailure"],
      ) &&
      value["ok"] === false &&
      value["code"] === "LEASE_RELEASE_FAILED_AFTER_COMMIT" &&
      value["status"] === "committed-no-recovery-lease-cleanup-failed" &&
      value["publicationCommitted"] === true &&
      value["recoveryRequired"] === false &&
      value["journalPresent"] === false &&
      value["journalState"] === "absent" &&
      value["publishedTargets"] === expectedTargets &&
      isRawDigest(value["transactionId"]) &&
      isRawDigest(value["requestDigest"]) &&
      isRawDigest(value["targetSetDigest"]) &&
      isRawDigest(value["baselineDigest"]) &&
      typeof value["message"] === "string" &&
      (value["commitmentSource"] === "publication" ||
        value["commitmentSource"] === "recovery") &&
      isRecord(value["evidence"])
    )
  ) {
    return false;
  }
  const evidence = value["evidence"];
  return (
    exactKeys(evidence, [
      "transactionId",
      "requestDigest",
      "leaseId",
      "detail",
    ]) &&
    evidence["transactionId"] === value["transactionId"] &&
    evidence["requestDigest"] === value["requestDigest"] &&
    typeof evidence["leaseId"] === "string" &&
    evidence["leaseId"].length > 0 &&
    typeof evidence["detail"] === "string" &&
    evidence["detail"].length > 0
  );
}

function isRawDigest(value: unknown): value is string {
  return typeof value === "string" && rawDigest.test(value);
}

function parseExpected(value: unknown): ExpectedSnapshot | undefined {
  if (!isRecord(value) || typeof value["state"] !== "string") return;
  if (value["state"] === "missing")
    return exactKeys(value, ["state"])
      ? Object.freeze({ state: "missing" })
      : undefined;
  if (
    !(
      value["state"] === "file" &&
      exactKeys(value, [
        "state",
        "identity",
        "deviceId",
        "byteLength",
        "contentDigest",
        "linkCount",
      ])
    )
  )
    return;
  if (
    typeof value["identity"] !== "string" ||
    value["identity"].length === 0 ||
    typeof value["deviceId"] !== "string" ||
    value["deviceId"].length === 0 ||
    typeof value["byteLength"] !== "number" ||
    !Number.isSafeInteger(value["byteLength"]) ||
    value["byteLength"] < 0 ||
    typeof value["contentDigest"] !== "string" ||
    !rawDigest.test(value["contentDigest"]) ||
    value["linkCount"] !== 1
  )
    return;
  return Object.freeze({
    state: "file",
    identity: value["identity"],
    deviceId: value["deviceId"],
    byteLength: value["byteLength"],
    contentDigest: value["contentDigest"],
    linkCount: 1,
  });
}

function normalizeTarget(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  )
    return;
  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  )
    return;
  return normalized;
}

function bytes(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length > maximumCandidateBytes) return;
  const result: number[] = [];
  for (const byte of value) {
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    )
      return;
    result.push(byte);
  }
  return Object.freeze(result);
}
