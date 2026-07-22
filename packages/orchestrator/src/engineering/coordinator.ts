import type { Digest } from "../digest.ts";
import type { TargetBaseline } from "../state/target.ts";
import type { CausalWorkflow } from "../workflow/contract.ts";
import { assessChange } from "./assurance/evidence.ts";
import { reviewAssuranceSecurity } from "./assurance/security.ts";
import { reserveContext } from "./context.ts";
import { ContinuationLedger } from "./continuation.ts";
import type {
  EngineeringContinuationCancelResult,
  EngineeringDescribeResult,
  EngineeringPrepareResult,
  EngineeringWorkflow,
  EngineeringWorkflowConfig,
} from "./contract.ts";
import { parseDescribeInput } from "./describe-input.ts";
import { parseEngineeringInput } from "./input.ts";
import { prepareEngineeringPhase2 } from "./phase2/prepare.ts";
import { attestPhysicalIntegration } from "./physical.ts";
import type { TaskContextResetResult } from "./reset/contract.ts";
import {
  type TaskAdmission,
  TaskContextController,
} from "./reset/controller.ts";
import { TaskEpochResources } from "./reset/resources.ts";
import { EngineeringReviewLifecycle } from "./reset/review.ts";
import { snapshotRecord } from "./snapshot.ts";
import {
  advanceSourceEngineering,
  startSourceEngineering,
} from "./source/adapter.ts";
import {
  describeSourceEngineering,
  sourceContextMatches,
  sourceRepository,
} from "./source/context.ts";
import { prepareBatch } from "./source/evidence.ts";
import {
  contextBindingsFor,
  continuationBindingsFor,
  describeBindings,
  freezePreparationState,
  matchesPreparation,
  operationFor,
  type PreparationContext,
  type PreparationState,
  sameContinuationBindings,
} from "./state.ts";

interface ContextRecord extends PreparationContext {
  consumed: boolean;
  readonly taskEpochDigest: Digest;
}

export class EngineeringCoordinator implements EngineeringWorkflow {
  private readonly config: EngineeringWorkflowConfig;
  private readonly causal: CausalWorkflow;
  private readonly contexts = new WeakMap<object, ContextRecord>();
  private readonly continuations = new ContinuationLedger<PreparationState>();
  private readonly resources: TaskEpochResources;
  private readonly reset: TaskContextController;
  private readonly reviews: EngineeringReviewLifecycle;

  constructor(config: EngineeringWorkflowConfig, causal: CausalWorkflow) {
    this.config = config;
    this.causal = causal;
    this.resources = new TaskEpochResources({
      continuations: this.continuations,
      causal,
      releaseBaseline: (state) => this.release(state.baseline),
      deleteContext: (context) => this.contexts.delete(context),
    });
    this.reset = new TaskContextController({
      taskId: config.causal.approvalContext.taskId,
      rootIdentity: config.causal.publicationIdentity.rootIdentity,
      discoveryRoot: config.discoveryRoot,
      runtime: config.taskRuntime,
      settle: (taskEpochDigest) => this.resources.settle(taskEpochDigest),
      invalidate: (taskEpochDigest) =>
        this.resources.invalidate(taskEpochDigest),
      restore: (input) =>
        config.causal.orchestrator.restoreTaskCheckpoint(input),
      discover: (input) => config.causal.orchestrator.discoverTask(input),
    });
    this.reviews = new EngineeringReviewLifecycle(
      causal,
      this.resources,
      this.reset,
    );
  }

  async describe(input: unknown): Promise<EngineeringDescribeResult> {
    const parsed = parseDescribeInput(input, this.config.validationProfiles);
    if (parsed === undefined) {
      return { status: "rejected", code: "INVALID_WORKFLOW_INPUT" };
    }
    const taskContext = this.reset.contextFor(
      parsed.request,
      parsed.repository,
    );
    const admission =
      taskContext === undefined
        ? undefined
        : this.reset.admitContext(taskContext);
    if (admission === undefined) {
      return { status: "rejected", code: "TASK_CONTEXT_STALE" };
    }
    try {
      const bindings = describeBindings(parsed);
      const budget = await reserveContext(this.config.contextBudget, {
        operation: "source-describe",
        ordinal: 0,
        expectedEpoch: null,
        bindings,
      });
      if (budget.status !== "reserved") {
        return { status: "rejected", code: "CONTEXT_BUDGET_REJECTED" };
      }
      if (!admission.active()) {
        return { status: "rejected", code: "TASK_CONTEXT_STALE" };
      }
      const result = await describeSourceEngineering(
        this.config.sourceEngineering,
        Object.freeze({
          requestDigest: parsed.request.intentDigest,
          repository: sourceRepository(this.config, parsed.repository),
          language: parsed.profile.language,
          objective: parsed.profile.objective,
          formatterId: parsed.profile.formatterId,
          targets: Object.freeze(
            parsed.targets.map((path) => Object.freeze({ path })),
          ),
        }),
      );
      if (
        !admission.active() ||
        result.status !== "described" ||
        !sourceContextMatches(result, parsed, this.config)
      ) {
        return { status: "rejected", code: "SOURCE_ENGINEERING_REJECTED" };
      }
      const record: ContextRecord = {
        input: parsed,
        receipt: result.receipt,
        receiptReference: result.receiptReference,
        consumed: false,
        taskEpochDigest: admission.taskEpochDigest,
      };
      this.contexts.set(result.context, record);
      this.resources.trackContext(admission.taskEpochDigest, result.context);
      return {
        status: "described",
        context: result.context,
        taskContext: admission.context,
      };
    } finally {
      admission.release();
    }
  }

  async prepare(input: unknown): Promise<EngineeringPrepareResult> {
    const parsed = parseEngineeringInput(input, this.config.validationProfiles);
    if (
      parsed === undefined ||
      typeof parsed.context !== "object" ||
      parsed.context === null
    ) {
      return rejected("INVALID_WORKFLOW_INPUT");
    }
    const context = this.contexts.get(parsed.context);
    if (
      context === undefined ||
      context.consumed ||
      !matchesPreparation(context, parsed)
    ) {
      return rejected("SOURCE_ENGINEERING_REJECTED");
    }
    const admission = this.reset.admitEpoch(context.taskEpochDigest);
    if (admission === undefined) return rejected("TASK_CONTEXT_STALE");
    try {
      context.consumed = true;
      const baselineResult =
        await this.config.causal.orchestrator.captureTargetBaseline({
          request: parsed.request,
          repository: parsed.repository,
          targets: parsed.targets.map((target) => target.path),
        });
      if (baselineResult.status !== "accepted") {
        return rejected("TARGET_BASELINE_REJECTED");
      }
      if (!admission.active()) {
        this.release(baselineResult.baseline);
        return rejected("TASK_CONTEXT_STALE");
      }
      return await this.drive(
        freezePreparationState({
          taskEpochDigest: admission.taskEpochDigest,
          input: parsed,
          context: Object.freeze({
            input: context.input,
            receipt: context.receipt,
            receiptReference: context.receiptReference,
          }),
          baseline: baselineResult.baseline,
          phase: "source-start",
          cursor: null,
          prepared: null,
          assurance: null,
          security: null,
          integrations: Object.freeze([]),
          integrationIndex: 0,
          budgetEpoch: null,
          ordinal: 0,
        }),
        admission,
      );
    } finally {
      admission.release();
    }
  }

  async continue(input: unknown): Promise<EngineeringPrepareResult> {
    const value = snapshotRecord(input, ["continuation"]);
    if (value === undefined) return rejected("CONTINUATION_REJECTED");
    const continuation = value["continuation"];
    const taskEpochDigest = this.continuations.epochFor(continuation);
    const admission =
      taskEpochDigest === undefined
        ? undefined
        : this.reset.admitEpoch(taskEpochDigest);
    if (admission === undefined) return rejected("CONTINUATION_REJECTED");
    try {
      const claim = this.continuations.claim(continuation);
      if (claim.status !== "accepted") return rejected(claim.code);
      const current = continuationBindingsFor(claim.state);
      if (!sameContinuationBindings(claim.bindings, current)) {
        this.release(claim.state.baseline);
        return rejected("CONTINUATION_DRIFTED");
      }
      const target =
        await this.config.causal.orchestrator.revalidateTargetBaseline(
          claim.state.baseline,
        );
      if (target.status !== "unchanged") {
        this.release(claim.state.baseline);
        return rejected("CONTINUATION_DRIFTED");
      }
      if (!admission.active()) {
        this.release(claim.state.baseline);
        return rejected("TASK_CONTEXT_STALE");
      }
      return await this.drive(claim.state, admission);
    } finally {
      admission.release();
    }
  }

  async cancelContinuation(
    input: unknown,
  ): Promise<EngineeringContinuationCancelResult> {
    const value = snapshotRecord(input, ["continuation"]);
    if (value === undefined) {
      return { status: "rejected", code: "INVALID_WORKFLOW_INPUT" };
    }
    const taskEpochDigest = this.continuations.epochFor(value["continuation"]);
    const admission =
      taskEpochDigest === undefined
        ? undefined
        : this.reset.admitEpoch(taskEpochDigest);
    if (admission === undefined) {
      return { status: "rejected", code: "CONTINUATION_REJECTED" };
    }
    const claim = this.continuations.claim(value["continuation"]);
    admission.release();
    if (claim.status !== "accepted") return claim;
    this.release(claim.state.baseline);
    this.reset.retireEpoch(claim.state.taskEpochDigest);
    return { status: "cancelled" };
  }

  async approveAndPromote(input: unknown) {
    return await this.reviews.approveAndPromote(input);
  }

  async reject(input: unknown) {
    return await this.reviews.reject(input);
  }

  async recover(input: unknown) {
    return await this.reviews.recover(input);
  }

  async retryCleanup(input: unknown) {
    return await this.reviews.retryCleanup(input);
  }

  resetContext(input: unknown): Promise<TaskContextResetResult> {
    return this.reset.resetContext(input);
  }

  resumeContextReset(input: unknown): Promise<TaskContextResetResult> {
    return this.reset.resumeContextReset(input);
  }

  private async drive(
    initial: PreparationState,
    admission: TaskAdmission,
  ): Promise<EngineeringPrepareResult> {
    let state = initial;
    while (state.ordinal <= 4096) {
      if (!admission.active()) return this.fail(state, "TASK_CONTEXT_STALE");
      const reservation = await reserveContext(this.config.contextBudget, {
        operation: operationFor(state),
        ordinal: state.ordinal,
        expectedEpoch: state.budgetEpoch,
        bindings: contextBindingsFor(state),
      });
      if (!admission.active()) return this.fail(state, "TASK_CONTEXT_STALE");
      if (reservation.status === "paused") {
        return this.pause(state, reservation.receipt);
      }
      if (reservation.status === "rejected") {
        return this.fail(state, reservation.code);
      }
      state = freezePreparationState({
        ...state,
        budgetEpoch: reservation.receipt.epoch,
        ordinal: state.ordinal + 1,
      });
      const progressed = await this.progress(state);
      if (!admission.active()) return this.fail(state, "TASK_CONTEXT_STALE");
      if ("status" in progressed) return progressed;
      state = progressed.state;
    }
    return this.fail(state, "CONTEXT_BUDGET_REJECTED");
  }

  private async progress(
    state: PreparationState,
  ): Promise<{ readonly state: PreparationState } | EngineeringPrepareResult> {
    if (state.phase === "source-start") return await this.startSource(state);
    if (state.phase === "source-advance")
      return await this.advanceSource(state);
    if (state.phase === "assurance") return await this.assessAssurance(state);
    if (state.phase === "security") return await this.reviewSecurity(state);
    if (state.phase === "physical") return await this.attestPhysical(state);
    return await this.preparePhase2(state);
  }

  private async startSource(state: PreparationState) {
    const result = await startSourceEngineering(
      this.config.sourceEngineering,
      Object.freeze({
        requestDigest: state.input.request.intentDigest,
        repository: sourceRepository(this.config, state.input.repository),
        language: state.input.profile.language,
        objective: state.input.profile.objective,
        targets: sourceEpochTargets(state.input.targets),
        formatterId: state.input.profile.formatterId,
        faultCases: state.input.faultDeclarations,
        context: state.context.receiptReference,
        contextDigest: state.context.receipt.contextDigest,
      }),
    );
    return this.acceptSourceResult(state, result);
  }

  private async advanceSource(state: PreparationState) {
    if (state.cursor === null)
      return this.fail(state, "SOURCE_ENGINEERING_REJECTED");
    const result = await advanceSourceEngineering(
      this.config.sourceEngineering,
      state.cursor.reference,
    );
    if (
      result.status === "ready" &&
      (result.cursor.requestDigest !== state.input.request.intentDigest ||
        result.cursor.step <= state.cursor.cursor.step)
    ) {
      return this.fail(state, "SOURCE_ENGINEERING_REJECTED");
    }
    return this.acceptSourceResult(state, result);
  }

  private acceptSourceResult(
    state: PreparationState,
    result: Awaited<ReturnType<typeof startSourceEngineering>>,
  ): { readonly state: PreparationState } | EngineeringPrepareResult {
    if (result.status === "rejected") {
      return this.fail(state, result.code);
    }
    if (result.status === "ready") {
      if (result.cursor.requestDigest !== state.input.request.intentDigest) {
        return this.fail(state, "SOURCE_ENGINEERING_REJECTED");
      }
      return {
        state: freezePreparationState({
          ...state,
          phase: "source-advance",
          cursor: Object.freeze({
            cursor: result.cursor,
            reference: result.cursorReference,
            next: result.next,
          }),
        }),
      };
    }
    const prepared = prepareBatch(
      result,
      state.input.targets.map(({ path }) => path),
    );
    if (
      prepared === undefined ||
      result.receipt.requestDigest !== state.input.request.intentDigest ||
      result.receipt.contextDigest !== state.context.receipt.contextDigest ||
      result.receipt.contextReceiptDigest !==
        state.context.receipt.receiptDigest
    ) {
      return this.fail(state, "SOURCE_ENGINEERING_REJECTED");
    }
    return {
      state: freezePreparationState({
        ...state,
        phase: "assurance",
        cursor: null,
        prepared,
      }),
    };
  }

  private async assessAssurance(state: PreparationState) {
    if (state.prepared === null)
      return this.fail(state, "SOURCE_ENGINEERING_REJECTED");
    const assurance = await assessChange(
      this.config.changeAssurance,
      Object.freeze({
        requestDigest: state.input.request.intentDigest,
        repositoryId: state.input.repository.repositoryId,
        treeDigest: state.input.repository.treeDigest,
        baselineDigest: state.baseline.baselineDigest,
        declaration: state.input.changeDeclaration,
      }),
      state.prepared,
    );
    if (assurance === undefined) {
      return this.fail(state, "CHANGE_ASSURANCE_REJECTED");
    }
    return {
      state: freezePreparationState({
        ...state,
        assurance,
        phase: "security",
      }),
    };
  }

  private async reviewSecurity(state: PreparationState) {
    if (state.assurance === null)
      return this.fail(state, "CHANGE_ASSURANCE_REJECTED");
    const security = await reviewAssuranceSecurity(
      this.config.securityPolicyLinter,
      this.config.independentSecurityReview,
      state.assurance,
    );
    if (security === undefined) {
      return this.fail(state, "SECURITY_REVIEW_REJECTED");
    }
    return {
      state: freezePreparationState({
        ...state,
        security,
        phase: state.input.integrations.length === 0 ? "phase2" : "physical",
      }),
    };
  }

  private async attestPhysical(state: PreparationState) {
    if (state.prepared === null)
      return this.fail(state, "SOURCE_ENGINEERING_REJECTED");
    const prepared = state.prepared;
    const declaration = state.input.integrations[state.integrationIndex];
    if (declaration === undefined) {
      return {
        state: freezePreparationState({ ...state, phase: "phase2" }),
      };
    }
    const result = await attestPhysicalIntegration(
      this.config.physicalIntegration,
      declaration,
      {
        requestDigest: state.input.request.intentDigest,
        repositoryId: state.input.repository.repositoryId,
        treeDigest: state.input.repository.treeDigest,
        baselineDigest: state.baseline.baselineDigest,
        candidateDigest: prepared.receipt.candidateDigest,
        provenanceDigest: prepared.receipt.provenanceDigest,
      },
      Object.freeze(
        prepared.artifacts.map((artifact, index) =>
          Object.freeze({
            path: artifact.path,
            digest: artifact.digest,
            byteLength: artifact.byteLength,
            bytes: prepared.candidateBytes[index] ?? Object.freeze([]),
          }),
        ),
      ),
    );
    if (result.status !== "accepted") return this.fail(state, result.code);
    const integrations = Object.freeze([...state.integrations, result.receipt]);
    const integrationIndex = state.integrationIndex + 1;
    return {
      state: freezePreparationState({
        ...state,
        integrations,
        integrationIndex,
        phase:
          integrationIndex === state.input.integrations.length
            ? "phase2"
            : "physical",
      }),
    };
  }

  private async preparePhase2(
    state: PreparationState,
  ): Promise<EngineeringPrepareResult> {
    return await prepareEngineeringPhase2({
      state,
      config: this.config,
      causal: this.causal,
      trackReview: (record) => this.resources.trackReview(record),
      trackPreReviewOutcome: (taskEpochDigest, result) =>
        this.resources.recordPreReviewOutcome(taskEpochDigest, result),
    });
  }

  private pause(
    state: PreparationState,
    budget: Extract<
      Awaited<ReturnType<typeof reserveContext>>,
      { status: "paused" }
    >["receipt"],
  ): EngineeringPrepareResult {
    const paused = freezePreparationState({
      ...state,
      budgetEpoch: budget.epoch,
    });
    const issued = this.continuations.issue(
      continuationBindingsFor(paused),
      paused,
    );
    if (issued.status !== "issued") return this.fail(state, issued.code);
    return {
      status: "paused",
      code: "CONTEXT_BUDGET_PAUSED",
      continuation: issued.continuation,
      budget,
    };
  }

  private fail(
    state: PreparationState,
    code: Parameters<typeof rejected>[0],
  ): EngineeringPrepareResult {
    this.release(state.baseline);
    return rejected(code);
  }

  private release(baseline: TargetBaseline): void {
    this.config.causal.orchestrator.releaseTargetBaseline(baseline);
  }
}

function sourceEpochTargets(
  targets: readonly import("./contract.ts").EngineeringTarget[],
) {
  let epoch = 0;
  return Object.freeze(
    targets.map((target) =>
      Object.freeze({
        path: target.path,
        operations: Object.freeze(
          target.operations.map((operation) => {
            epoch += 1;
            return Object.freeze({ epoch, ...operation });
          }),
        ),
      }),
    ),
  );
}

function rejected(
  code: import("./contract.ts").EngineeringFailureCode,
): EngineeringPrepareResult {
  return { status: "rejected", code, cleanup: null };
}
