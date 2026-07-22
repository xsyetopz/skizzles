import { exactKeys, isRecord } from "../../codec.ts";
import type { WorkflowCleanupResult } from "../causal/contract.ts";
import { isWorkflowCleanupHandle } from "../lifecycle.ts";
import type { CleanupRecord } from "../record.ts";
import { preparationResult } from "./preparation.ts";

export async function retryWorkflowCleanup(
  input: unknown,
  records: Map<string, CleanupRecord>,
  releaseTaskApproval: (
    registration: CleanupRecord["taskApprovalRegistration"],
  ) => void,
): Promise<WorkflowCleanupResult> {
  if (
    !(
      isRecord(input) &&
      exactKeys(input, ["handle"]) &&
      isWorkflowCleanupHandle(input["handle"])
    )
  ) {
    return { status: "rejected", code: "INVALID_WORKFLOW_INPUT" };
  }
  const record = records.get(input["handle"].workflowId);
  if (
    record === undefined ||
    record.lifecycle.handle !== input["handle"] ||
    record.state !== "cleanup-pending"
  ) {
    return { status: "rejected", code: "WORKFLOW_STALE" };
  }
  const cleanup = await record.lifecycle.close();
  if (!cleanup.complete) {
    return {
      status: "cleanup-pending",
      code: "CLEANUP_FAILED",
      handle: record.lifecycle.handle,
      cleanup,
    };
  }
  record.state = "closed";
  releaseTaskApproval(record.taskApprovalRegistration);
  records.delete(input["handle"].workflowId);
  if (record.deferredPreparation !== undefined) {
    return preparationResult(record.deferredPreparation, cleanup);
  }
  return {
    status: "cleaned",
    cleanup,
    publication: record.publication,
    recovery: record.recovery,
  };
}
