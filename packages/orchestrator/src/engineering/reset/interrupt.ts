import { type Digest, digestValue } from "../../digest.ts";
import { snapshotRecord } from "../snapshot.ts";
import type { TaskRuntimeInterruptRequest } from "./contract.ts";
import type { ResetRecord, TaskResetEnvironment } from "./state.ts";

export async function interruptTaskRuntime(
  environment: TaskResetEnvironment,
  record: ResetRecord,
): Promise<Digest | undefined> {
  const request: TaskRuntimeInterruptRequest = Object.freeze({
    taskId: record.previous.taskId,
    repositoryId: record.previous.repository.repositoryId,
    requestDigest: record.previous.request.intentDigest,
    treeDigest: record.previous.repository.treeDigest,
    taskEpochDigest: record.previous.taskEpochDigest,
    interruptId: record.interruptId,
    reason: "context-renewal",
  });
  let raw: unknown;
  try {
    raw = await bounded(
      environment.runtime.interrupt(request),
      environment.runtime.timeoutMilliseconds,
    );
  } catch {
    return;
  }
  const receipt = snapshotRecord(raw, [
    "taskId",
    "repositoryId",
    "requestDigest",
    "treeDigest",
    "taskEpochDigest",
    "interruptId",
    "reason",
    "interrupted",
    "quiescent",
    "receiptDigest",
  ]);
  if (receipt === undefined) return;
  const material = { ...request, interrupted: true, quiescent: true };
  return receipt["taskId"] === material.taskId &&
    receipt["repositoryId"] === material.repositoryId &&
    receipt["requestDigest"] === material.requestDigest &&
    receipt["treeDigest"] === material.treeDigest &&
    receipt["taskEpochDigest"] === material.taskEpochDigest &&
    receipt["interruptId"] === material.interruptId &&
    receipt["reason"] === material.reason &&
    receipt["interrupted"] === true &&
    receipt["quiescent"] === true &&
    receipt["receiptDigest"] === digestValue(material)
    ? (receipt["receiptDigest"] as Digest)
    : undefined;
}

async function bounded<Value>(
  operation: Value | Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), timeoutMilliseconds);
  });
  try {
    return await Promise.race([Promise.resolve(operation), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
