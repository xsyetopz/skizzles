import { createHash } from "node:crypto";
import type { RecoveryResult } from "@skizzles/workspace-publication";
import { exactKeys, isRecord } from "../codec.ts";
import { digestValue } from "../digest.ts";
import type { TransactionApprovalReceipt } from "./approval/bridge.ts";
import type {
  PublicationIdentity,
  WorkflowRecoveryHandle,
} from "./causal/contract.ts";

const rawDigest = /^[0-9a-f]{64}$/u;
const handles = new WeakSet<object>();

export interface RecoveryRequestMaterial {
  readonly version: 1;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly ownerId: string;
  readonly transactionId: string;
  readonly requestDigest: string;
  readonly approvalDigest: string;
  readonly targetSetDigest: string;
  readonly baselineDigest: string;
  readonly publishedTargets: number;
}

export function createRecoveryRequest(
  identity: PublicationIdentity,
  receipt: TransactionApprovalReceipt,
  publishedTargets: number,
): RecoveryRequestMaterial | undefined {
  if (
    receipt.bindings.repositoryId !== identity.repositoryId ||
    receipt.bindings.rootIdentity !== identity.rootIdentity ||
    receipt.bindings.ownerId !== identity.ownerId ||
    !rawDigest.test(receipt.bindings.requestDigest) ||
    !rawDigest.test(receipt.bindings.targetSetDigest) ||
    !rawDigest.test(receipt.bindings.baselineDigest) ||
    !Number.isSafeInteger(publishedTargets) ||
    publishedTargets <= 0 ||
    !rawDigest.test(receipt.approvalDigest)
  ) {
    return;
  }
  const transactionId = rawValueDigest({
    requestDigest: receipt.bindings.requestDigest,
    approvalDigest: receipt.approvalDigest,
  });
  return Object.freeze({
    version: 1,
    repositoryId: identity.repositoryId,
    rootIdentity: identity.rootIdentity,
    ownerId: identity.ownerId,
    transactionId,
    requestDigest: receipt.bindings.requestDigest,
    approvalDigest: receipt.approvalDigest,
    targetSetDigest: receipt.bindings.targetSetDigest,
    baselineDigest: receipt.bindings.baselineDigest,
    publishedTargets,
  });
}

export function recoveryRequestInput(request: RecoveryRequestMaterial): object {
  return Object.freeze({
    version: request.version,
    repositoryId: request.repositoryId,
    rootIdentity: request.rootIdentity,
    ownerId: request.ownerId,
    transactionId: request.transactionId,
    requestDigest: request.requestDigest,
    approvalDigest: request.approvalDigest,
  });
}

export function createRecoveryHandle(
  workflowId: string,
  request: RecoveryRequestMaterial,
  sequence: number,
): WorkflowRecoveryHandle {
  const handle = Object.freeze({
    workflowId,
    recoveryDigest: digestValue({ workflowId, request, sequence }),
  });
  handles.add(handle);
  return handle;
}

export function isWorkflowRecoveryHandle(
  value: unknown,
): value is WorkflowRecoveryHandle {
  return typeof value === "object" && value !== null && handles.has(value);
}

export function exactRecoverySuccess(
  value: RecoveryResult,
  request: RecoveryRequestMaterial,
): value is Extract<RecoveryResult, { readonly ok: true }> {
  if (!(isRecord(value) && value["ok"] === true)) return false;
  if (value["status"] === "no-journal") {
    return exactKeys(value, ["ok", "status"]);
  }
  if (value["status"] === "recovered-old") {
    return (
      exactKeys(value, ["ok", "status", "transactionId", "journalState"]) &&
      value["transactionId"] === request.transactionId &&
      isJournalState(value["journalState"])
    );
  }
  return (
    value["status"] === "recovered-new" &&
    exactKeys(value, [
      "ok",
      "status",
      "publicationCommitted",
      "journalPresent",
      "recoveryRequired",
      "transactionId",
      "requestDigest",
      "targetSetDigest",
      "baselineDigest",
      "publishedTargets",
      "journalState",
    ]) &&
    value["publicationCommitted"] === true &&
    value["journalPresent"] === false &&
    value["recoveryRequired"] === false &&
    value["transactionId"] === request.transactionId &&
    value["requestDigest"] === request.requestDigest &&
    value["targetSetDigest"] === request.targetSetDigest &&
    value["baselineDigest"] === request.baselineDigest &&
    value["publishedTargets"] === request.publishedTargets &&
    isJournalState(value["journalState"])
  );
}

function rawValueDigest(value: Readonly<Record<string, string>>): string {
  const canonical = `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`)
    .join(",")}}`;
  return createHash("sha256").update(canonical).digest("hex");
}

function isJournalState(value: unknown): boolean {
  return (
    value === "preparing" ||
    value === "prepared" ||
    value === "publishing" ||
    value === "committed" ||
    value === "cleanup-pending"
  );
}
