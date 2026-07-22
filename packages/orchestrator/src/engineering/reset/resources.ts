import { type Digest, digestValue } from "../../digest.ts";
import type {
  CausalWorkflow,
  WorkflowCleanupHandle,
  WorkflowPrepareResult,
  WorkflowRecoveryHandle,
  WorkflowReview,
} from "../../workflow/causal/contract.ts";
import type { EngineeringReview } from "../contract.ts";
import type { ContinuationLedger } from "../session/continuation.ts";
import type { PreparationState } from "../session/state.ts";
import type { ResetSettlement } from "./controller.ts";

export interface TaskReviewRecord {
  readonly phase2: WorkflowReview;
  readonly taskEpochDigest: Digest;
  readonly review: EngineeringReview;
}

type WorkflowObservedResult =
  | Awaited<ReturnType<CausalWorkflow["approveAndPromote"]>>
  | Awaited<ReturnType<CausalWorkflow["reject"]>>
  | Awaited<ReturnType<CausalWorkflow["recover"]>>
  | Awaited<ReturnType<CausalWorkflow["retryCleanup"]>>;

type PreReviewObservedResult = WorkflowPrepareResult | WorkflowObservedResult;

interface EpochWorkflowState {
  readonly reviews: Set<TaskReviewRecord>;
  readonly pending: Map<
    string,
    Readonly<{
      kind: "recovery" | "cleanup";
      handle: WorkflowCleanupHandle | WorkflowRecoveryHandle;
    }>
  >;
  publicationOutcome:
    | "none"
    | "not-published"
    | "recovered-old"
    | "recovered-new"
    | "committed";
  readonly cleanupDigests: Set<string>;
}

export class TaskEpochResources {
  private readonly continuations: ContinuationLedger<PreparationState>;
  private readonly causal: CausalWorkflow;
  private readonly releaseBaseline: (state: PreparationState) => void;
  private readonly deleteContext: (context: object) => void;
  private readonly contexts = new Map<Digest, Set<object>>();
  private readonly reviewRecords = new WeakMap<object, TaskReviewRecord>();
  private readonly reviews = new Map<Digest, Set<TaskReviewRecord>>();
  private readonly workflows = new Map<Digest, EpochWorkflowState>();
  private readonly handles = new WeakMap<object, Digest>();
  private readonly invalidations = new Map<Digest, Digest>();

  constructor(input: {
    continuations: ContinuationLedger<PreparationState>;
    causal: CausalWorkflow;
    releaseBaseline: (state: PreparationState) => void;
    deleteContext: (context: object) => void;
  }) {
    this.continuations = input.continuations;
    this.causal = input.causal;
    this.releaseBaseline = input.releaseBaseline;
    this.deleteContext = input.deleteContext;
  }

  trackContext(taskEpochDigest: Digest, context: object): void {
    const contexts = this.contexts.get(taskEpochDigest) ?? new Set();
    contexts.add(context);
    this.contexts.set(taskEpochDigest, contexts);
  }

  trackReview(record: TaskReviewRecord): void {
    this.reviewRecords.set(record.review, record);
    const records = this.reviews.get(record.taskEpochDigest) ?? new Set();
    records.add(record);
    this.reviews.set(record.taskEpochDigest, records);
    this.workflowFor(record.taskEpochDigest).reviews.add(record);
  }

  reviewFor(value: unknown): TaskReviewRecord | undefined {
    return typeof value === "object" && value !== null
      ? this.reviewRecords.get(value)
      : undefined;
  }

  epochForHandle(value: unknown): Digest | undefined {
    return typeof value === "object" && value !== null
      ? this.handles.get(value)
      : undefined;
  }

  recordReviewOutcome(
    record: TaskReviewRecord,
    result: WorkflowObservedResult,
  ): void {
    if (operationalRejection(result)) return;
    this.applyOutcome(
      record.taskEpochDigest,
      record.phase2.workflowId,
      result,
      "review",
    );
    if (
      result.status !== "recovery-required" &&
      result.status !== "cleanup-pending"
    ) {
      this.workflowFor(record.taskEpochDigest).reviews.delete(record);
      this.reviews.get(record.taskEpochDigest)?.delete(record);
      this.reviewRecords.delete(record.review);
    }
  }

  recordPreReviewOutcome(
    taskEpochDigest: Digest,
    result: PreReviewObservedResult,
  ): void {
    if (
      result.status !== "cleanup-pending" &&
      result.status !== "recovery-required"
    ) {
      return;
    }
    this.applyOutcome(
      taskEpochDigest,
      result.handle.workflowId,
      result,
      "review",
    );
  }

  recordHandleOutcome(
    taskEpochDigest: Digest,
    handle: object,
    result: WorkflowObservedResult,
  ): void {
    if (operationalRejection(result)) return;
    const state = this.workflowFor(taskEpochDigest);
    const entry = [...state.pending.entries()].find(
      ([, pending]) => pending.handle === handle,
    );
    if (entry === undefined) return;
    this.applyOutcome(taskEpochDigest, entry[0], result, "handle", handle);
  }

  private applyOutcome(
    taskEpochDigest: Digest,
    workflowId: string,
    result: WorkflowObservedResult,
    source: "review" | "handle",
    sourceHandle?: object,
  ): void {
    const state = this.workflowFor(taskEpochDigest);
    if (result.status === "recovery-required") {
      if (result.handle.workflowId !== workflowId) return;
      state.pending.set(workflowId, {
        kind: "recovery",
        handle: result.handle,
      });
      this.handles.set(result.handle, taskEpochDigest);
      return;
    }
    if (result.status === "cleanup-pending") {
      if (result.handle.workflowId !== workflowId) return;
      state.pending.set(workflowId, {
        kind: "cleanup",
        handle: result.handle,
      });
      this.handles.set(result.handle, taskEpochDigest);
      state.cleanupDigests.add(result.cleanup.receiptDigest);
      return;
    }
    const owned = state.pending.get(workflowId);
    if (
      owned !== undefined &&
      (source !== "handle" ||
        owned.handle !== sourceHandle ||
        !completeCleanup(result))
    ) {
      return;
    }
    if (source === "handle" && owned === undefined) return;
    state.pending.delete(workflowId);
    if (source === "handle") {
      for (const review of [...state.reviews]) {
        if (review.phase2.workflowId !== workflowId) continue;
        this.reviewRecords.delete(review.review);
        state.reviews.delete(review);
        this.reviews.get(taskEpochDigest)?.delete(review);
      }
    }
    if ("cleanup" in result && result.cleanup !== null) {
      state.cleanupDigests.add(result.cleanup.receiptDigest);
    }
    state.publicationOutcome = mergePublicationOutcome(
      state.publicationOutcome,
      publicationOutcome(result, state),
    );
  }

  async settle(taskEpochDigest: Digest): Promise<ResetSettlement> {
    const abandoned = this.continuations.revokeEpoch(taskEpochDigest);
    for (const state of abandoned) this.releaseBaseline(state);
    const workflow = this.workflowFor(taskEpochDigest);
    if (workflow.pending.size > 0) {
      return await this.resumePending(taskEpochDigest, workflow);
    }
    for (const review of [...workflow.reviews]) {
      const result = await rejectWorkflow(this.causal, review.phase2);
      this.recordReviewOutcome(review, result);
      if (result.status === "recovery-required") {
        return { status: "pending", stage: "recovery" };
      }
      if (result.status === "cleanup-pending") {
        return { status: "pending", stage: "cleanup" };
      }
      if (
        result.status === "rejected" &&
        (result.code === "WORKFLOW_BUSY" || result.code === "WORKFLOW_STALE")
      ) {
        return { status: "pending", stage: "cleanup" };
      }
    }
    if (workflow.pending.size > 0) {
      return await this.resumePending(taskEpochDigest, workflow);
    }
    return this.settled(workflow);
  }

  private async resumePending(
    taskEpochDigest: Digest,
    workflow: EpochWorkflowState,
  ): Promise<ResetSettlement> {
    const entry = workflow.pending.entries().next().value;
    if (entry === undefined) return await this.settle(taskEpochDigest);
    const [, pending] = entry;
    if (pending.kind === "recovery") {
      const result = await this.causal.recover({ handle: pending.handle });
      this.recordHandleOutcome(taskEpochDigest, pending.handle, result);
      if (result.status === "recovery-required") {
        return { status: "pending", stage: "recovery" };
      }
      if (result.status === "cleanup-pending") {
        return { status: "pending", stage: "cleanup" };
      }
    } else {
      const result = await this.causal.retryCleanup({ handle: pending.handle });
      this.recordHandleOutcome(taskEpochDigest, pending.handle, result);
      if (result.status === "cleanup-pending") {
        return { status: "pending", stage: "cleanup" };
      }
    }
    const next = workflow.pending.values().next().value;
    if (next !== undefined) {
      return { status: "pending", stage: next.kind };
    }
    if (workflow.reviews.size > 0) return await this.settle(taskEpochDigest);
    return this.settled(workflow);
  }

  private settled(workflow: EpochWorkflowState): ResetSettlement {
    return {
      status: "settled",
      workflowCleanupDigest: digestValue(
        Object.freeze([...workflow.cleanupDigests].sort()),
      ),
      publicationOutcome: workflow.publicationOutcome,
    };
  }

  invalidate(taskEpochDigest: Digest): Digest {
    const existing = this.invalidations.get(taskEpochDigest);
    if (existing !== undefined) return existing;
    const contextKeys = this.contexts.get(taskEpochDigest) ?? new Set();
    for (const context of contextKeys) this.deleteContext(context);
    this.contexts.delete(taskEpochDigest);
    const records = this.reviews.get(taskEpochDigest) ?? new Set();
    for (const record of records) this.reviewRecords.delete(record.review);
    this.reviews.delete(taskEpochDigest);
    const invalidationDigest = digestValue({
      taskEpochDigest,
      contexts: contextKeys.size,
      reviews: records.size,
      invalidated: true,
    });
    this.invalidations.set(taskEpochDigest, invalidationDigest);
    return invalidationDigest;
  }

  private workflowFor(taskEpochDigest: Digest): EpochWorkflowState {
    const current = this.workflows.get(taskEpochDigest);
    if (current !== undefined) return current;
    const created: EpochWorkflowState = {
      reviews: new Set(),
      pending: new Map(),
      publicationOutcome: "none",
      cleanupDigests: new Set(),
    };
    this.workflows.set(taskEpochDigest, created);
    return created;
  }
}

function operationalRejection(result: WorkflowObservedResult): boolean {
  return (
    result.status === "rejected" &&
    (result.code === "INVALID_WORKFLOW_INPUT" ||
      result.code === "WORKFLOW_BUSY" ||
      result.code === "WORKFLOW_STALE")
  );
}

async function rejectWorkflow(
  causal: CausalWorkflow,
  review: WorkflowReview,
): Promise<WorkflowObservedResult> {
  return await Reflect.apply(causal.reject, causal, [{ review }]);
}

function completeCleanup(result: WorkflowObservedResult): boolean {
  return (
    "cleanup" in result &&
    result.cleanup !== null &&
    result.cleanup.complete === true
  );
}

function publicationOutcome(
  result: WorkflowObservedResult,
  state: EpochWorkflowState,
): EpochWorkflowState["publicationOutcome"] {
  if (result.status === "publication-committed-cleanup-failed") {
    return "committed";
  }
  if (result.status === "completed") {
    return "recovery" in result
      ? recoveryOutcome(result.recovery.status)
      : "committed";
  }
  if (result.status === "recovered-without-publication") {
    return recoveryOutcome(result.recovery.status);
  }
  if (result.status === "cleaned") {
    if (result.recovery !== null) {
      return recoveryOutcome(result.recovery.status);
    }
    if (result.publication !== null) return "committed";
  }
  return state.publicationOutcome === "none"
    ? "not-published"
    : state.publicationOutcome;
}

function recoveryOutcome(
  status: "no-journal" | "recovered-old" | "recovered-new",
): "recovered-old" | "recovered-new" {
  return status === "recovered-new" ? "recovered-new" : "recovered-old";
}

function mergePublicationOutcome(
  current: EpochWorkflowState["publicationOutcome"],
  observed: EpochWorkflowState["publicationOutcome"],
): EpochWorkflowState["publicationOutcome"] {
  const priority: Readonly<
    Record<EpochWorkflowState["publicationOutcome"], number>
  > = {
    none: 0,
    "not-published": 1,
    "recovered-old": 2,
    "recovered-new": 3,
    committed: 4,
  };
  return priority[observed] > priority[current] ? observed : current;
}
