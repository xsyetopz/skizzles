import {
  create as createRunWorkspace,
  type RunWorkspace,
} from "@skizzles/run-workspace";
import {
  type PublicationResult,
  type RecoveryResult,
  type WorkspaceTransaction,
} from "@skizzles/workspace-transaction";
import { exactKeys, isRecord } from "../codec.ts";
import { digestValue } from "../digest.ts";
import type { NormalizedRequest } from "../intent.ts";
import type { RepositoryContext } from "../repository.ts";
import type { ExecutionSession } from "../state/execution.ts";
import type { TargetBaseline } from "../state/target.ts";
import {
  runWorkflowCommands,
  workspaceWithinQuota,
} from "./candidate-runner.ts";
import type {
  CausalWorkflow,
  CausalWorkflowConfig,
  TerminalPublication,
  WorkflowCleanupResult,
  WorkflowFailureCode,
  WorkflowPrepareResult,
  WorkflowPromotionResult,
  WorkflowRecoveryResult,
  WorkflowRejectionResult,
  WorkflowReview,
} from "./contract.ts";
import { isWorkflowCleanupHandle, WorkflowLifecycle } from "./lifecycle.ts";
import { parsePrepareInput } from "./prepare-input.ts";
import {
  capturePublicationBaseline,
  exactCommittedCleanupFailure,
  exactPublicationSuccess,
  type PreparedPublication,
  preparePublication,
  TransactionApprovalBridge,
} from "./publication.ts";
import {
  createRecoveryHandle,
  createRecoveryRequest,
  exactRecoverySuccess,
  isWorkflowRecoveryHandle,
  type RecoveryRequestMaterial,
  recoveryRequestInput,
} from "./recovery.ts";

interface WorkflowRecord {
  readonly lifecycle: WorkflowLifecycle;
  readonly workspace: RunWorkspace;
  readonly baseline: TargetBaseline;
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly prepared: PreparedPublication;
  review: WorkflowReview;
  state:
    | "awaiting"
    | "approving"
    | "publishing"
    | "recovery"
    | "cleanup-pending"
    | "closed";
  publication: TerminalPublication | null;
  recovery: Extract<RecoveryResult, { readonly ok: true }> | null;
}

interface CleanupRecord {
  readonly lifecycle: WorkflowLifecycle;
  state:
    | "awaiting"
    | "approving"
    | "publishing"
    | "recovery"
    | "cleanup-pending"
    | "closed";
  publication: TerminalPublication | null;
  recovery: Extract<RecoveryResult, { readonly ok: true }> | null;
}

interface ActiveRecovery {
  readonly record: WorkflowRecord;
  readonly request: RecoveryRequestMaterial;
}

const reviews = new WeakMap<object, WorkflowRecord>();

export class WorkflowCoordinator implements CausalWorkflow {
  private sequence = 0;
  private readonly config: CausalWorkflowConfig;
  private readonly transaction: WorkspaceTransaction;
  private readonly bridge: TransactionApprovalBridge;
  private readonly cleanup = new Map<string, CleanupRecord>();
  private readonly recoveries = new WeakMap<object, ActiveRecovery>();
  private recoverySequence = 0;

  constructor(
    config: CausalWorkflowConfig,
    transaction: WorkspaceTransaction,
    bridge: TransactionApprovalBridge,
  ) {
    this.config = config;
    this.transaction = transaction;
    this.bridge = bridge;
  }

  async prepare(input: unknown): Promise<WorkflowPrepareResult> {
    const parsed = parsePrepareInput(input, this.config.commandProfiles);
    if (
      parsed === undefined ||
      parsed.repository.repositoryId !==
        this.config.publicationIdentity.repositoryId
    ) {
      return {
        status: "rejected",
        code: "INVALID_WORKFLOW_INPUT",
        cleanup: null,
      };
    }
    const baselineResult = await this.config.orchestrator.captureTargetBaseline(
      {
        request: parsed.request,
        repository: parsed.repository,
        targets: parsed.targets.map((target) => target.path),
      },
    );
    if (baselineResult.status !== "accepted") {
      return {
        status: "rejected",
        code: "TARGET_BASELINE_REJECTED",
        cleanup: null,
      };
    }
    const workflowId = this.nextWorkflowId(baselineResult.baseline);
    const lifecycle = new WorkflowLifecycle(
      workflowId,
      this.config.orchestrator,
      baselineResult.baseline,
    );
    const discovery = await this.config.orchestrator.discover({
      request: parsed.request,
      repository: parsed.repository,
      root: parsed.discoveryRoot,
    });
    if (discovery.status !== "accepted" || !discovery.discovery.complete) {
      return this.rejectPreparation("DISCOVERY_INCOMPLETE", lifecycle);
    }
    const started = this.config.orchestrator.startExecution({
      request: parsed.request,
      repository: parsed.repository,
    });
    if (started.status !== "accepted")
      return this.rejectPreparation("EXECUTION_BUDGET_REJECTED", lifecycle);
    let workspace: RunWorkspace;
    try {
      workspace = await createRunWorkspace();
      lifecycle.ownWorkspace(workspace);
    } catch {
      return this.failStartedPreparation(
        "WORKSPACE_REJECTED",
        lifecycle,
        started.execution,
      );
    }
    const operationResult = await runWorkflowCommands({
      orchestrator: this.config.orchestrator,
      profiles: this.config.commandProfiles,
      workspace,
      limits: this.config.workspaceUsageLimits,
      targets: parsed.targets,
      commands: parsed.commands,
      execution: started.execution,
    });
    if (operationResult.audits === null)
      return this.failStartedPreparation(
        "COMMAND_OBSERVATION_REJECTED",
        lifecycle,
        operationResult.execution,
      );
    const captured = await capturePublicationBaseline(
      this.config.baselineAuthority,
      baselineResult.baseline,
      parsed.targets,
    );
    if (captured === undefined)
      return this.failStartedPreparation(
        "PUBLICATION_BASELINE_REJECTED",
        lifecycle,
        operationResult.execution,
      );
    const prepared = await preparePublication(
      this.config.publicationIdentity,
      parsed.repository,
      baselineResult.baseline,
      captured,
      parsed.targets,
    );
    if (prepared === undefined)
      return this.failStartedPreparation(
        "DIFF_REJECTED",
        lifecycle,
        operationResult.execution,
      );
    if (
      !(await workspaceWithinQuota(workspace, this.config.workspaceUsageLimits))
    )
      return this.failStartedPreparation(
        "WORKSPACE_QUOTA_REJECTED",
        lifecycle,
        operationResult.execution,
      );
    const planned = this.config.orchestrator.planApproval({
      ...this.config.approvalContext,
      request: parsed.request,
      repository: parsed.repository,
      baseline: baselineResult.baseline,
      discovery: discovery.discovery,
      transactionDigest: prepared.transactionDigest,
      diffBytes: prepared.diffBytes,
    });
    if (planned.status !== "accepted")
      return this.failStartedPreparation(
        "APPROVAL_REJECTED",
        lifecycle,
        operationResult.execution,
      );
    lifecycle.ownApproval(planned.approval);
    const reviewed = this.config.orchestrator.reviewApproval({
      approval: planned.approval,
    });
    if (reviewed.status !== "accepted")
      return this.failStartedPreparation(
        "APPROVAL_REJECTED",
        lifecycle,
        operationResult.execution,
      );
    lifecycle.updateApproval(reviewed.approval);
    const awaiting = this.config.orchestrator.awaitApproval({
      approval: reviewed.approval,
    });
    if (awaiting.status !== "accepted")
      return this.failStartedPreparation(
        "APPROVAL_REJECTED",
        lifecycle,
        operationResult.execution,
      );
    lifecycle.updateApproval(awaiting.approval);
    const completion = await this.config.orchestrator.completeExecution({
      execution: operationResult.execution,
    });
    if (completion.status !== "completed")
      return this.failStartedPreparation(
        "COMPLETION_CONTRACT_REJECTED",
        lifecycle,
        operationResult.execution,
      );
    const review: WorkflowReview = Object.freeze({
      workflowId,
      approval: awaiting.approval,
      diffDigest: awaiting.approval.diffDigest,
      commandAudits: Object.freeze(operationResult.audits),
    });
    const record: WorkflowRecord = {
      lifecycle,
      workspace,
      baseline: baselineResult.baseline,
      request: parsed.request,
      repository: parsed.repository,
      prepared,
      review,
      state: "awaiting",
      publication: null,
      recovery: null,
    };
    reviews.set(review, record);
    this.cleanup.set(workflowId, record);
    return { status: "awaiting-approval", review };
  }

  async approveAndPromote(input: unknown): Promise<WorkflowPromotionResult> {
    if (!(isRecord(input) && exactKeys(input, ["review", "token"])))
      return {
        status: "rejected",
        code: "INVALID_WORKFLOW_INPUT",
        cleanup: null,
      };
    const record = recordForReview(input["review"]);
    if (record === undefined || input["review"] !== record.review)
      return { status: "rejected", code: "WORKFLOW_STALE", cleanup: null };
    if (record.state !== "awaiting")
      return { status: "rejected", code: "WORKFLOW_BUSY", cleanup: null };
    record.state = "approving";
    const approved = await this.config.orchestrator.approve({
      approval: record.review.approval,
      token: input["token"],
    });
    if (approved.status !== "accepted")
      return this.rejectPromotion(record, approvalCode(approved.code));
    record.lifecycle.updateApproval(approved.approval);
    if (
      !(await workspaceWithinQuota(
        record.workspace,
        this.config.workspaceUsageLimits,
      ))
    )
      return this.rejectPromotion(record, "WORKSPACE_QUOTA_REJECTED");
    const target = await this.config.orchestrator.revalidateTargetBaseline(
      record.baseline,
    );
    if (target.status !== "unchanged")
      return this.rejectPromotion(record, "APPROVAL_DRIFTED");
    const promotion = await this.config.orchestrator.promote({
      approval: approved.approval,
    });
    if (promotion.status !== "promoting")
      return this.rejectPromotion(record, approvalCode(promotion.code));
    record.lifecycle.markApprovalTerminal();
    record.state = "publishing";
    this.bridge.activate(
      record.prepared.reference,
      promotion.permit,
      this.config.publicationIdentity,
    );
    let publication: PublicationResult | undefined;
    try {
      publication = await this.transaction.publish(record.prepared.request);
    } catch {
      publication = undefined;
    } finally {
      this.bridge.deactivate(record.prepared.reference);
    }
    const receipt = this.bridge.takeReceipt(record.prepared.reference);
    if (publication === undefined) {
      return this.retainRecovery(record, receipt);
    }
    if (
      exactCommittedCleanupFailure(publication, record.prepared.targetCount)
    ) {
      record.publication = publication;
      return this.finishCommittedCleanupFailure(record, publication);
    }
    if (!exactPublicationSuccess(publication, record.prepared.targetCount)) {
      if (receipt !== undefined) return this.retainRecovery(record, receipt);
      return this.rejectPromotion(record, "PUBLICATION_REJECTED");
    }
    record.publication = publication;
    return this.finishPromotion(record, publication);
  }

  async reject(input: unknown): Promise<WorkflowRejectionResult> {
    if (!(isRecord(input) && exactKeys(input, ["review"])))
      return {
        status: "rejected",
        code: "INVALID_WORKFLOW_INPUT",
        cleanup: null,
      };
    const record = recordForReview(input["review"]);
    if (record === undefined || input["review"] !== record.review)
      return { status: "rejected", code: "WORKFLOW_STALE", cleanup: null };
    if (record.state !== "awaiting")
      return { status: "rejected", code: "WORKFLOW_BUSY", cleanup: null };
    record.state = "cleanup-pending";
    const cancelled = this.config.orchestrator.cancelApproval({
      approval: record.review.approval,
    });
    if (
      cancelled.status === "cancelled" ||
      cancelled.code === "APPROVAL_CANCELLED"
    )
      record.lifecycle.markApprovalTerminal();
    const cleanup = await record.lifecycle.close();
    if (!cleanup.complete)
      return {
        status: "cleanup-pending",
        code: "CLEANUP_FAILED",
        handle: record.lifecycle.handle,
        cleanup,
      };
    record.state = "closed";
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
    this.cleanup.delete(active.record.review.workflowId);
    if (raw.status === "recovered-new") {
      return { status: "completed", recovery: raw, cleanup };
    }
    return { status: "recovered-without-publication", recovery: raw, cleanup };
  }

  async retryCleanup(input: unknown): Promise<WorkflowCleanupResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["handle"]) &&
        isWorkflowCleanupHandle(input["handle"])
      )
    )
      return { status: "rejected", code: "INVALID_WORKFLOW_INPUT" };
    const record = this.cleanup.get(input["handle"].workflowId);
    if (
      record === undefined ||
      record.lifecycle.handle !== input["handle"] ||
      record.state !== "cleanup-pending"
    )
      return { status: "rejected", code: "WORKFLOW_STALE" };
    const cleanup = await record.lifecycle.close();
    if (!cleanup.complete)
      return {
        status: "cleanup-pending",
        code: "CLEANUP_FAILED",
        handle: record.lifecycle.handle,
        cleanup,
      };
    record.state = "closed";
    this.cleanup.delete(input["handle"].workflowId);
    return {
      status: "cleaned",
      cleanup,
      publication: record.publication,
      recovery: record.recovery,
    };
  }

  private async rejectPreparation(
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

  private failStartedPreparation(
    code: WorkflowFailureCode,
    lifecycle: WorkflowLifecycle,
    execution: ExecutionSession,
  ): Promise<WorkflowPrepareResult> {
    this.config.orchestrator.terminateExecution({
      execution,
      kind: "failed",
    });
    return this.rejectPreparation(code, lifecycle);
  }

  private async rejectPromotion(
    record: WorkflowRecord,
    code: WorkflowFailureCode,
  ): Promise<WorkflowPromotionResult> {
    record.state = "cleanup-pending";
    const cleanup = await record.lifecycle.close();
    if (!cleanup.complete)
      return {
        status: "cleanup-pending",
        code: "CLEANUP_FAILED",
        handle: record.lifecycle.handle,
        cleanup,
      };
    record.state = "closed";
    this.cleanup.delete(record.review.workflowId);
    return { status: "rejected", code, cleanup };
  }

  private async finishPromotion(
    record: WorkflowRecord,
    publication: Extract<PublicationResult, { readonly ok: true }>,
  ): Promise<WorkflowPromotionResult> {
    record.state = "cleanup-pending";
    const cleanup = await record.lifecycle.close();
    if (!cleanup.complete)
      return {
        status: "cleanup-pending",
        code: "CLEANUP_FAILED",
        handle: record.lifecycle.handle,
        cleanup,
      };
    record.state = "closed";
    this.cleanup.delete(record.review.workflowId);
    return { status: "completed", publication, cleanup };
  }

  private async finishCommittedCleanupFailure(
    record: WorkflowRecord,
    publication: TerminalPublication & {
      readonly status: "committed-no-recovery-lease-cleanup-failed";
      readonly recoveryRequired: false;
    },
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
    this.cleanup.delete(record.review.workflowId);
    return {
      status: "publication-committed-cleanup-failed",
      code: "PUBLICATION_CLEANUP_FAILED",
      publication,
      cleanup,
    };
  }

  private retainRecovery(
    record: WorkflowRecord,
    receipt: ReturnType<TransactionApprovalBridge["takeReceipt"]>,
  ): WorkflowPromotionResult {
    if (receipt === undefined) {
      return {
        status: "rejected",
        code: "PUBLICATION_REJECTED",
        cleanup: null,
      };
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

  private nextWorkflowId(baseline: TargetBaseline): string {
    this.sequence += 1;
    return digestValue({
      reservationId: baseline.reservationId,
      sequence: this.sequence,
    });
  }
}

function approvalCode(code: string): WorkflowFailureCode {
  if (code === "APPROVAL_EXPIRED") return "APPROVAL_EXPIRED";
  return code === "APPROVAL_DRIFTED" ? "APPROVAL_DRIFTED" : "APPROVAL_REJECTED";
}

function recordForReview(value: unknown): WorkflowRecord | undefined {
  return typeof value === "object" && value !== null
    ? reviews.get(value)
    : undefined;
}
