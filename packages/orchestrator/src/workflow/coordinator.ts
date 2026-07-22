import type {
  PublicationResult,
  WorkspaceTransaction,
} from "@skizzles/workspace-publication";
import { exactKeys, isRecord } from "../codec.ts";
import { digestValue } from "../digest.ts";
import type { TargetBaseline } from "../state/target.ts";
import type { TransactionApprovalBridge } from "./approval/bridge.ts";
import { prepareWorkflowApproval } from "./approval/prepare.ts";
import type {
  CausalWorkflow,
  CausalWorkflowConfig,
  WorkflowFailureCode,
  WorkflowPrepareResult,
  WorkflowPromotionResult,
  WorkflowRejectionResult,
  WorkflowReview,
} from "./causal/contract.ts";
import { WorkflowCompletion } from "./completion.ts";
import {
  finalizeWorkflowEvidence,
  revalidateWorkflowEvidenceDraft,
  workflowVerificationMaterial,
} from "./evidence.ts";
import { WorkflowLifecycle } from "./lifecycle.ts";
import { acceptPreparedBaseline, parsePrepareInput } from "./prepare-input.ts";
import {
  capturePublicationBaseline,
  exactCommittedCleanupFailure,
  exactPublicationSuccess,
  preparePublication,
} from "./publication.ts";
import type { WorkflowRecord } from "./record.ts";
import type { WorkflowTaskVerificationBindings } from "./verification/task-contract.ts";
import { prepareWorkflowTask } from "./worktree/prepare.ts";
import {
  commitWorkflowTask,
  revalidatePromotionState,
} from "./worktree/promotion.ts";
import { runWorkflowTask } from "./worktree/run.ts";
import {
  executeWorkflowTaskVerification,
  revalidateWorkflowTaskVerification,
} from "./worktree/verification.ts";

const reviews = new WeakMap<object, WorkflowRecord>();

export class WorkflowCoordinator implements CausalWorkflow {
  private sequence = 0;
  private readonly config: CausalWorkflowConfig;
  private readonly transaction: WorkspaceTransaction;
  private readonly bridge: TransactionApprovalBridge;
  private readonly completion: WorkflowCompletion;

  constructor(
    config: CausalWorkflowConfig,
    transaction: WorkspaceTransaction,
    bridge: TransactionApprovalBridge,
  ) {
    this.config = config;
    this.transaction = transaction;
    this.bridge = bridge;
    this.completion = new WorkflowCompletion(config, transaction);
  }

  async prepare(input: unknown): Promise<WorkflowPrepareResult> {
    const parsed = parsePrepareInput(input);
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
    const baselineResult =
      parsed.baseline === null
        ? await this.config.orchestrator.captureTargetBaseline({
            request: parsed.request,
            repository: parsed.repository,
            targets: parsed.targets.map((target) => target.path),
          })
        : await acceptPreparedBaseline(
            this.config.orchestrator,
            parsed.baseline,
            parsed.request.intentDigest,
            parsed.repository.repositoryId,
            parsed.repository.treeDigest,
            parsed.targets.map((target) => target.path),
          );
    if (baselineResult.status !== "accepted") {
      return {
        status: "rejected",
        code: "TARGET_BASELINE_REJECTED",
        cleanup: null,
      };
    }
    const workflowId = this.nextWorkflowId(baselineResult.baseline);
    const taskEpochDigest =
      parsed.taskEpochDigest ??
      digestValue({
        workflowId,
        taskId: this.config.approvalContext.taskId,
        repositoryId: parsed.repository.repositoryId,
      });
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
      return this.completion.rejectPreparation(
        "DISCOVERY_INCOMPLETE",
        lifecycle,
      );
    }
    const captured = await capturePublicationBaseline(
      this.config.baselineAuthority,
      baselineResult.baseline,
      parsed.targets,
    );
    if (captured === undefined) {
      return this.completion.rejectPreparation(
        "PUBLICATION_BASELINE_REJECTED",
        lifecycle,
      );
    }
    const verificationMaterial = workflowVerificationMaterial(
      parsed.engineeringEvidenceDraft,
    );
    if (
      verificationMaterial === undefined ||
      !(await revalidateWorkflowEvidenceDraft(parsed.engineeringEvidenceDraft))
    ) {
      return this.completion.rejectPreparation(
        "ENGINEERING_EVIDENCE_REJECTED",
        lifecycle,
      );
    }
    const taskPreparation = await prepareWorkflowTask(
      this.config,
      parsed,
      baselineResult.baseline,
      captured,
      lifecycle,
      taskEpochDigest,
    );
    if (taskPreparation.status === "terminal") {
      return this.completion.finishPreparation(
        taskPreparation.outcome,
        lifecycle,
      );
    }
    if (taskPreparation.status === "rejected") {
      return this.completion.rejectPreparation(
        "TASK_WORKTREE_REJECTED",
        lifecycle,
      );
    }
    const started = this.config.orchestrator.startExecution({
      request: parsed.request,
      repository: parsed.repository,
    });
    if (started.status !== "accepted") {
      return this.completion.rejectPreparation(
        "EXECUTION_BUDGET_REJECTED",
        lifecycle,
      );
    }
    const run = await runWorkflowTask(
      this.config,
      taskPreparation.session,
      parsed.profileIds,
      started.execution,
    );
    if (run.status !== "ran") {
      return this.completion.failStartedPreparation(
        run.code,
        lifecycle,
        run.execution,
      );
    }
    const execution = run.execution;
    const verificationBindings: WorkflowTaskVerificationBindings =
      Object.freeze({
        taskId: this.config.approvalContext.taskId,
        taskEpochDigest,
        requestDigest: parsed.request.intentDigest,
        repositoryId: parsed.repository.repositoryId,
        rootIdentity: this.config.publicationIdentity.rootIdentity,
        treeDigest: parsed.repository.treeDigest,
        baselineDigest: baselineResult.baseline.baselineDigest,
      });
    const verificationObjectives =
      this.config.verificationAuthority.deriveObjectives(verificationMaterial);
    if (verificationObjectives === undefined) {
      return this.completion.failStartedPreparation(
        "VERIFICATION_GATE_REJECTED",
        lifecycle,
        execution,
      );
    }
    const taskVerification = await executeWorkflowTaskVerification({
      taskWorktree: this.config.taskWorktree,
      orchestrator: this.config.orchestrator,
      session: taskPreparation.session,
      taskReceipt: run.receipt,
      bindings: verificationBindings,
      profileIds: this.config.verificationProfiles,
      execution,
      objectives: verificationObjectives,
    });
    if (taskVerification.status !== "verified") {
      return this.completion.failStartedPreparation(
        taskVerification.code,
        lifecycle,
        taskVerification.execution,
      );
    }
    const gate = await this.config.verificationAuthority.evaluate({
      bindings: Object.freeze({
        ...verificationBindings,
        candidateDigest: run.receipt.candidateDigest,
        candidateManifestDigest: run.receipt.candidateManifestDigest,
        specLockDigest: run.receipt.specificationLockDigest,
        baselineManifestDigest: run.receipt.baselineTestManifestDigest,
      }),
      material: verificationMaterial,
      taskWorktree: this.config.taskWorktree,
      session: taskPreparation.session,
      receipts: taskVerification.receipts,
    });
    if (gate.status !== "accepted") {
      return this.completion.failStartedPreparation(
        "VERIFICATION_GATE_REJECTED",
        lifecycle,
        taskVerification.execution,
      );
    }
    const engineeringEvidence = await finalizeWorkflowEvidence(
      parsed.engineeringEvidenceDraft,
      Object.freeze({
        verification: gate.evidence,
        taskVerification: taskVerification.receipts,
      }),
      async () =>
        (await revalidateWorkflowTaskVerification({
          taskWorktree: this.config.taskWorktree,
          session: taskPreparation.session,
          taskReceipt: run.receipt,
          bindings: verificationBindings,
          profileIds: this.config.verificationProfiles,
          receipts: taskVerification.receipts,
        })) &&
        (await this.config.verificationAuthority.verify(gate.evidence))
          .status === "valid",
    );
    if (engineeringEvidence === undefined) {
      return this.completion.failStartedPreparation(
        "ENGINEERING_EVIDENCE_REJECTED",
        lifecycle,
        taskVerification.execution,
      );
    }
    const prepared = await preparePublication(
      this.config.publicationIdentity,
      parsed.repository,
      baselineResult.baseline,
      captured,
      parsed.targets,
      run.receipt,
      parsed.profileIds,
      engineeringEvidence,
    );
    if (prepared === undefined) {
      return this.completion.failStartedPreparation(
        "DIFF_REJECTED",
        lifecycle,
        execution,
      );
    }
    const approval = await prepareWorkflowApproval(
      this.config,
      parsed,
      baselineResult.baseline,
      discovery.discovery,
      prepared,
      taskVerification.execution,
      lifecycle,
    );
    if (approval.status === "rejected") {
      return this.completion.failStartedPreparation(
        approval.code,
        lifecycle,
        execution,
      );
    }
    const review: WorkflowReview = Object.freeze({
      workflowId,
      approval: approval.approval,
      diffDigest: approval.approval.diffDigest,
      taskWorktreeReceipt: run.receipt,
      executedProfileIds: parsed.profileIds,
      taskVerificationReceipts: taskVerification.receipts.ordered,
      verificationGateReceipt: gate.evidence.receipt,
      engineeringEvidence,
    });
    const taskApprovalRegistration = this.config.taskWorktreeApproval.register({
      approval: approval.approval,
      receipt: run.receipt,
      profileIds: parsed.profileIds,
      verificationReceipts: taskVerification.receipts.ordered,
      repositoryId: parsed.repository.repositoryId,
      rootIdentity: this.config.publicationIdentity.rootIdentity,
    });
    if (taskApprovalRegistration === undefined) {
      return this.completion.failStartedPreparation(
        "APPROVAL_REJECTED",
        lifecycle,
        execution,
      );
    }
    const record: WorkflowRecord = {
      lifecycle,
      taskSession: taskPreparation.session,
      taskApprovalRegistration,
      baseline: baselineResult.baseline,
      request: parsed.request,
      repository: parsed.repository,
      prepared,
      engineeringEvidence,
      preparedTaskReceipt: run.receipt,
      taskVerification: taskVerification.receipts,
      verification: gate.evidence,
      commitReceipt: null,
      review,
      state: "awaiting",
      publication: null,
      recovery: null,
    };
    reviews.set(review, record);
    this.completion.track(record);
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
      return this.completion.rejectPromotion(
        record,
        approvalCode(approved.code),
      );
    record.lifecycle.updateApproval(approved.approval);
    const revalidation = await revalidatePromotionState(
      this.config,
      record.taskSession,
      record.preparedTaskReceipt,
      record.baseline,
      record.engineeringEvidence,
      Object.freeze({
        taskId: this.config.approvalContext.taskId,
        taskEpochDigest: record.preparedTaskReceipt.taskEpochDigest,
        requestDigest: record.request.intentDigest,
        repositoryId: record.repository.repositoryId,
        rootIdentity: this.config.publicationIdentity.rootIdentity,
        treeDigest: record.repository.treeDigest,
        baselineDigest: record.baseline.baselineDigest,
      }),
      this.config.verificationProfiles,
      record.taskVerification,
      record.verification,
    );
    if (revalidation !== null)
      return this.completion.rejectPromotion(record, revalidation);
    const promotion = await this.config.orchestrator.promote({
      approval: approved.approval,
    });
    if (promotion.status !== "promoting")
      return this.completion.rejectPromotion(
        record,
        approvalCode(promotion.code),
      );
    record.lifecycle.markApprovalTerminal();
    const committed = await commitWorkflowTask(
      this.config,
      record.taskSession,
      record.preparedTaskReceipt,
      promotion.permit,
    );
    if (committed === undefined) {
      return this.completion.rejectPromotion(
        record,
        "TASK_WORKTREE_COMMIT_REJECTED",
      );
    }
    record.commitReceipt = committed;
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
      return this.completion.retainRecovery(record, receipt);
    }
    if (
      exactCommittedCleanupFailure(publication, record.prepared.targetCount)
    ) {
      record.publication = publication;
      return this.completion.finishCommittedCleanupFailure(record, publication);
    }
    if (!exactPublicationSuccess(publication, record.prepared.targetCount)) {
      if (receipt !== undefined) {
        return this.completion.retainRecovery(record, receipt);
      }
      return this.completion.rejectPromotion(record, "PUBLICATION_REJECTED");
    }
    record.publication = publication;
    return this.completion.finishPromotion(record, publication);
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
    return this.completion.reject(record);
  }

  recover(input: unknown) {
    return this.completion.recover(input);
  }

  retryCleanup(input: unknown) {
    return this.completion.retryCleanup(input);
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
