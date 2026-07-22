import type {
  CausalWorkflow,
  WorkflowCleanupResult,
  WorkflowPromotionResult,
  WorkflowRecoveryResult,
  WorkflowRejectionResult,
} from "../../workflow/contract.ts";
import { snapshotRecord } from "../snapshot.ts";
import type { TaskContextController } from "./controller.ts";
import type { TaskEpochResources } from "./resources.ts";

export class EngineeringReviewLifecycle {
  private readonly causal: CausalWorkflow;
  private readonly resources: TaskEpochResources;
  private readonly reset: TaskContextController;

  constructor(
    causal: CausalWorkflow,
    resources: TaskEpochResources,
    reset: TaskContextController,
  ) {
    this.causal = causal;
    this.resources = resources;
    this.reset = reset;
  }

  async approveAndPromote(input: unknown): Promise<WorkflowPromotionResult> {
    const value = snapshotRecord(input, ["review", "token"]);
    if (value === undefined) return rejectedPromotion("INVALID_WORKFLOW_INPUT");
    const record = this.resources.reviewFor(value["review"]);
    if (record === undefined) return rejectedPromotion("WORKFLOW_STALE");
    const admission = this.reset.admitEpoch(record.taskEpochDigest);
    if (admission === undefined) return rejectedPromotion("WORKFLOW_STALE");
    try {
      const result = await this.causal.approveAndPromote({
        review: record.phase2,
        token: value["token"],
      });
      this.resources.recordReviewOutcome(record, result);
      if (terminalWorkflowResult(result)) {
        this.reset.retireEpoch(record.taskEpochDigest);
      }
      return result;
    } finally {
      admission.release();
    }
  }

  async reject(input: unknown): Promise<WorkflowRejectionResult> {
    const value = snapshotRecord(input, ["review"]);
    if (value === undefined) return rejectedRejection("INVALID_WORKFLOW_INPUT");
    const record = this.resources.reviewFor(value["review"]);
    if (record === undefined) return rejectedRejection("WORKFLOW_STALE");
    const admission = this.reset.admitEpoch(record.taskEpochDigest);
    if (admission === undefined) return rejectedRejection("WORKFLOW_STALE");
    try {
      const result = await this.causal.reject({ review: record.phase2 });
      this.resources.recordReviewOutcome(record, result);
      if (terminalWorkflowResult(result)) {
        this.reset.retireEpoch(record.taskEpochDigest);
      }
      return result;
    } finally {
      admission.release();
    }
  }

  async recover(input: unknown): Promise<WorkflowRecoveryResult> {
    const handle = snapshotRecord(input, ["handle"])?.["handle"];
    if (typeof handle !== "object" || handle === null) {
      return { status: "rejected", code: "WORKFLOW_STALE" };
    }
    const epoch = this.resources.epochForHandle(handle);
    const admission =
      epoch === undefined ? undefined : this.reset.admitEpoch(epoch);
    if (admission === undefined) {
      return { status: "rejected", code: "WORKFLOW_STALE" };
    }
    try {
      const result = await this.causal.recover({ handle });
      this.resources.recordHandleOutcome(
        admission.taskEpochDigest,
        handle,
        result,
      );
      if (terminalWorkflowResult(result)) {
        this.reset.retireEpoch(admission.taskEpochDigest);
      }
      return result;
    } finally {
      admission.release();
    }
  }

  async retryCleanup(input: unknown): Promise<WorkflowCleanupResult> {
    const handle = snapshotRecord(input, ["handle"])?.["handle"];
    if (typeof handle !== "object" || handle === null) {
      return { status: "rejected", code: "WORKFLOW_STALE" };
    }
    const epoch = this.resources.epochForHandle(handle);
    const admission =
      epoch === undefined ? undefined : this.reset.admitEpoch(epoch);
    if (admission === undefined) {
      return { status: "rejected", code: "WORKFLOW_STALE" };
    }
    try {
      const result = await this.causal.retryCleanup({ handle });
      this.resources.recordHandleOutcome(
        admission.taskEpochDigest,
        handle,
        result,
      );
      if (terminalWorkflowResult(result)) {
        this.reset.retireEpoch(admission.taskEpochDigest);
      }
      return result;
    } finally {
      admission.release();
    }
  }
}

function rejectedPromotion(
  code: "INVALID_WORKFLOW_INPUT" | "WORKFLOW_STALE",
): WorkflowPromotionResult {
  return { status: "rejected", code, cleanup: null };
}

function rejectedRejection(
  code: "INVALID_WORKFLOW_INPUT" | "WORKFLOW_STALE",
): WorkflowRejectionResult {
  return { status: "rejected", code, cleanup: null };
}

function terminalWorkflowResult(result: { readonly status: string }): boolean {
  if (
    "code" in result &&
    (result.code === "INVALID_WORKFLOW_INPUT" ||
      result.code === "WORKFLOW_BUSY" ||
      result.code === "WORKFLOW_STALE")
  ) {
    return false;
  }
  return (
    result.status !== "recovery-required" && result.status !== "cleanup-pending"
  );
}
