import type { TaskWorktreePrepareTerminalResult } from "@skizzles/task-worktree";
import type {
  PublicationResult,
  RecoveryResult,
  WorkspaceTransaction,
} from "@skizzles/workspace-publication";
import { exactKeys, isRecord } from "../codec.ts";
import type { ExecutionSession } from "../state/execution.ts";
import type { TransactionApprovalBridge } from "./approval/bridge.ts";
import type {
  CausalWorkflowConfig,
  TerminalPublication,
  WorkflowCleanupResult,
  WorkflowFailureCode,
  WorkflowPrepareResult,
  WorkflowPromotionResult,
  WorkflowRecoveryResult,
  WorkflowRejectionResult,
} from "./causal/contract.ts";
import { preparationResult } from "./completion/preparation.ts";
import { retryWorkflowCleanup } from "./completion/retry.ts";
import type { WorkflowLifecycle } from "./lifecycle.ts";
import type { CleanupRecord, WorkflowRecord } from "./record.ts";
import {
  createRecoveryHandle,
  createRecoveryRequest,
  exactRecoverySuccess,
  isWorkflowRecoveryHandle,
  type RecoveryRequestMaterial,
  recoveryRequestInput,
} from "./recovery.ts";

interface ActiveRecovery {
  readonly record: WorkflowRecord;
  readonly request: RecoveryRequestMaterial;
}

export class WorkflowCompletion {
  private readonly config: CausalWorkflowConfig;
  private readonly transaction: WorkspaceTransaction;
  private readonly cleanup = new Map<string, CleanupRecord>();
  private readonly recoveries = new WeakMap<object, ActiveRecovery>();
  private recoverySequence = 0;

  constructor(config: CausalWorkflowConfig, transaction: WorkspaceTransaction) {
    this.config = config;
    this.transaction = transaction;
  }

  track(record: WorkflowRecord): void {
    this.cleanup.set(record.review.workflowId, record);
  }

  async reject(record: WorkflowRecord): Promise<WorkflowRejectionResult> {
    record.state = "cleanup-pending";
    const cancelled = this.config.orchestrator.cancelApproval({
      approval: record.review.approval,
    });
    if (
      cancelled.status === "cancelled" ||
      cancelled.code === "APPROVAL_CANCELLED"
    ) {
      record.lifecycle.markApprovalTerminal();
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
    this.releaseTaskApproval(record.taskApprovalRegistration);
    this.cleanup.delete(record.review.workflowId);
    return { status: "rejected", code: "APPROVAL_REJECTED", cleanup };
  }

  async recover(input: unknown): Promise<WorkflowRecoveryResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["handle"]) &&
        isWorkflowRecoveryHandle(input["handle"])
      )
    ) {
      return { status: "rejected", code: "INVALID_WORKFLOW_INPUT" };
    }
    const active = this.recoveries.get(input["handle"]);
    if (
      active === undefined ||
      active.record.state !== "recovery" ||
      active.record.review.workflowId !== input["handle"].workflowId
    ) {
      return { status: "rejected", code: "WORKFLOW_STALE" };
    }
    this.recoveries.delete(input["handle"]);
    active.record.state = "publishing";
    let raw: RecoveryResult | undefined;
    try {
      raw = await this.transaction.recover(
        recoveryRequestInput(active.request),
      );
    } catch {
      raw = undefined;
    }
    if (raw === undefined || !exactRecoverySuccess(raw, active.request)) {
      active.record.state = "recovery";
      return {
        status: "recovery-required",
        code: "RECOVERY_REJECTED",
        handle: this.nextRecoveryHandle(active.record, active.request),
      };
    }
    active.record.recovery = raw;
    active.record.state = "cleanup-pending";
    const cleanup = await active.record.lifecycle.close();
    if (!cleanup.complete) {
      return {
        status: "cleanup-pending",
        code: "CLEANUP_FAILED",
        handle: active.record.lifecycle.handle,
        cleanup,
      };
    }
    active.record.state = "closed";
    this.releaseTaskApproval(active.record.taskApprovalRegistration);
    this.cleanup.delete(active.record.review.workflowId);
    return raw.status === "recovered-new"
      ? { status: "completed", recovery: raw, cleanup }
      : { status: "recovered-without-publication", recovery: raw, cleanup };
  }

  async retryCleanup(input: unknown): Promise<WorkflowCleanupResult> {
    return await retryWorkflowCleanup(input, this.cleanup, (registration) => {
      this.releaseTaskApproval(registration);
    });
  }

  async finishPreparation(
    outcome: TaskWorktreePrepareTerminalResult,
    lifecycle: WorkflowLifecycle,
  ): Promise<WorkflowPrepareResult> {
    const cleanup = await lifecycle.close();
    if (cleanup.complete) return preparationResult(outcome, cleanup);
    this.cleanup.set(lifecycle.handle.workflowId, {
      lifecycle,
      state: "cleanup-pending",
      publication: null,
      recovery: null,
      deferredPreparation: outcome,
    });
    return {
      status: "cleanup-pending",
      code: "CLEANUP_FAILED",
      handle: lifecycle.handle,
      cleanup,
    };
  }

  async rejectPreparation(
    code: WorkflowFailureCode,
    lifecycle: WorkflowLifecycle,
  ): Promise<WorkflowPrepareResult> {
    const cleanup = await lifecycle.close();
    if (cleanup.complete) return { status: "rejected", code, cleanup };
    this.cleanup.set(lifecycle.handle.workflowId, {
      lifecycle,
      state: "cleanup-pending",
      publication: null,
      recovery: null,
    });
    return {
      status: "cleanup-pending",
      code: "CLEANUP_FAILED",
      handle: lifecycle.handle,
      cleanup,
    };
  }

  failStartedPreparation(
    code: WorkflowFailureCode,
    lifecycle: WorkflowLifecycle,
    execution: ExecutionSession,
  ): Promise<WorkflowPrepareResult> {
    this.config.orchestrator.terminateExecution({ execution, kind: "failed" });
    return this.rejectPreparation(code, lifecycle);
  }

  rejectPromotion(
    record: WorkflowRecord,
    code: WorkflowFailureCode,
  ): Promise<WorkflowPromotionResult> {
    return this.closePromotion(record, { status: "rejected", code });
  }

  finishPromotion(
    record: WorkflowRecord,
    publication: Extract<PublicationResult, { readonly ok: true }>,
  ): Promise<WorkflowPromotionResult> {
    return this.closePromotion(record, { status: "completed", publication });
  }

  finishCommittedCleanupFailure(
    record: WorkflowRecord,
    publication: TerminalPublication & {
      readonly status: "committed-no-recovery-lease-cleanup-failed";
      readonly recoveryRequired: false;
    },
  ): Promise<WorkflowPromotionResult> {
    return this.closePromotion(record, {
      status: "publication-committed-cleanup-failed",
      code: "PUBLICATION_CLEANUP_FAILED",
      publication,
    });
  }

  async retainRecovery(
    record: WorkflowRecord,
    receipt: ReturnType<TransactionApprovalBridge["takeReceipt"]>,
  ): Promise<WorkflowPromotionResult> {
    if (receipt === undefined) {
      return this.rejectPromotion(record, "PUBLICATION_REJECTED");
    }
    const request = createRecoveryRequest(
      this.config.publicationIdentity,
      receipt,
      record.prepared.targetCount,
    );
    if (request === undefined) {
      return {
        status: "rejected",
        code: "PUBLICATION_UNCERTAIN",
        cleanup: null,
      };
    }
    record.state = "recovery";
    return {
      status: "recovery-required",
      code: "PUBLICATION_UNCERTAIN",
      handle: this.nextRecoveryHandle(record, request),
    };
  }

  private async closePromotion(
    record: WorkflowRecord,
    result:
      | Readonly<{ status: "rejected"; code: WorkflowFailureCode }>
      | Readonly<{
          status: "completed";
          publication: Extract<PublicationResult, { readonly ok: true }>;
        }>
      | Readonly<{
          status: "publication-committed-cleanup-failed";
          code: "PUBLICATION_CLEANUP_FAILED";
          publication: TerminalPublication & {
            readonly status: "committed-no-recovery-lease-cleanup-failed";
            readonly recoveryRequired: false;
          };
        }>,
  ): Promise<WorkflowPromotionResult> {
    record.state = "cleanup-pending";
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
    this.releaseTaskApproval(record.taskApprovalRegistration);
    this.cleanup.delete(record.review.workflowId);
    return { ...result, cleanup };
  }

  private nextRecoveryHandle(
    record: WorkflowRecord,
    request: RecoveryRequestMaterial,
  ) {
    this.recoverySequence += 1;
    const handle = createRecoveryHandle(
      record.review.workflowId,
      request,
      this.recoverySequence,
    );
    this.recoveries.set(handle, { record, request });
    return handle;
  }

  private releaseTaskApproval(
    registration: WorkflowRecord["taskApprovalRegistration"] | undefined,
  ): void {
    if (registration !== undefined) {
      this.config.taskWorktreeApproval.unregister(registration);
    }
  }
}
