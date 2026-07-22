import { digestValue } from "../digest.ts";
import type { TargetBaseline } from "../state/target.ts";
import type { CausalWorkflow, WorkflowReview } from "../workflow/contract.ts";
import { issueWorkflowEvidence } from "../workflow/evidence.ts";
import { assessChange, verifyAssurance } from "./assurance/evidence.ts";
import type { ContextBindings } from "./context.ts";
import { reserveContext } from "./context.ts";
import { ContinuationLedger } from "./continuation.ts";
import type {
  EngineeringContinuationCancelResult,
  EngineeringDescribeResult,
  EngineeringPrepareResult,
  EngineeringReview,
  EngineeringWorkflow,
  EngineeringWorkflowConfig,
} from "./contract.ts";
import {
  type ParsedDescribeInput,
  parseDescribeInput,
} from "./describe-input.ts";
import { type ParsedEngineeringInput, parseEngineeringInput } from "./input.ts";
import { negativeTestEvidenceMatches } from "./negative-evidence.ts";
import { attestPhysicalIntegration } from "./physical.ts";
import { snapshotRecord } from "./snapshot.ts";
import {
  advanceSourceEngineering,
  startSourceEngineering,
} from "./source/adapter.ts";
import { describeSourceEngineering } from "./source/context.ts";
import {
  createEvidenceBytes,
  createPreview,
  prepareBatch,
  verifyPrepared,
} from "./source/evidence.ts";
import {
  contextBindingsFor,
  continuationBindingsFor,
  freezePreparationState,
  operationFor,
  type PreparationContext,
  type PreparationState,
  sameContinuationBindings,
} from "./state.ts";

interface ContextRecord extends PreparationContext {
  consumed: boolean;
}

interface ReviewRecord {
  readonly phase2: WorkflowReview;
}

const reviews = new WeakMap<object, ReviewRecord>();

export class EngineeringCoordinator implements EngineeringWorkflow {
  private readonly config: EngineeringWorkflowConfig;
  private readonly causal: CausalWorkflow;
  private readonly contexts = new WeakMap<object, ContextRecord>();
  private readonly continuations = new ContinuationLedger<PreparationState>();

  constructor(config: EngineeringWorkflowConfig, causal: CausalWorkflow) {
    this.config = config;
    this.causal = causal;
  }

  async describe(input: unknown): Promise<EngineeringDescribeResult> {
    const parsed = parseDescribeInput(input, this.config.validationProfiles);
    if (parsed === undefined) {
      return { status: "rejected", code: "INVALID_WORKFLOW_INPUT" };
    }
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
      result.status !== "described" ||
      !matchesContext(result, parsed, this.config)
    ) {
      return { status: "rejected", code: "SOURCE_ENGINEERING_REJECTED" };
    }
    const record: ContextRecord = {
      input: parsed,
      receipt: result.receipt,
      receiptReference: result.receiptReference,
      consumed: false,
    };
    this.contexts.set(result.context, record);
    return { status: "described", context: result.context };
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
    return await this.drive(
      freezePreparationState({
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
        integrations: Object.freeze([]),
        integrationIndex: 0,
        budgetEpoch: null,
        ordinal: 0,
      }),
    );
  }

  async continue(input: unknown): Promise<EngineeringPrepareResult> {
    const value = snapshotRecord(input, ["continuation"]);
    if (value === undefined) return rejected("CONTINUATION_REJECTED");
    const continuation = value["continuation"];
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
    return await this.drive(claim.state);
  }

  async cancelContinuation(
    input: unknown,
  ): Promise<EngineeringContinuationCancelResult> {
    const value = snapshotRecord(input, ["continuation"]);
    if (value === undefined) {
      return { status: "rejected", code: "INVALID_WORKFLOW_INPUT" };
    }
    const claim = this.continuations.claim(value["continuation"]);
    if (claim.status !== "accepted") return claim;
    this.release(claim.state.baseline);
    return { status: "cancelled" };
  }

  async approveAndPromote(input: unknown) {
    const value = snapshotRecord(input, ["review", "token"]);
    if (value === undefined) {
      return {
        status: "rejected" as const,
        code: "INVALID_WORKFLOW_INPUT" as const,
        cleanup: null,
      };
    }
    const record = reviewRecord(value["review"]);
    if (record === undefined) {
      return {
        status: "rejected" as const,
        code: "WORKFLOW_STALE" as const,
        cleanup: null,
      };
    }
    return await this.causal.approveAndPromote({
      review: record.phase2,
      token: value["token"],
    });
  }

  async reject(input: unknown) {
    const value = snapshotRecord(input, ["review"]);
    if (value === undefined) {
      return {
        status: "rejected" as const,
        code: "INVALID_WORKFLOW_INPUT" as const,
        cleanup: null,
      };
    }
    const record = reviewRecord(value["review"]);
    if (record === undefined) {
      return {
        status: "rejected" as const,
        code: "WORKFLOW_STALE" as const,
        cleanup: null,
      };
    }
    return await this.causal.reject({ review: record.phase2 });
  }

  async recover(input: unknown) {
    const value = snapshotRecord(input, ["handle"]);
    return await this.causal.recover(
      value === undefined ? undefined : { handle: value["handle"] },
    );
  }

  async retryCleanup(input: unknown) {
    const value = snapshotRecord(input, ["handle"]);
    return await this.causal.retryCleanup(
      value === undefined ? undefined : { handle: value["handle"] },
    );
  }

  private async drive(
    initial: PreparationState,
  ): Promise<EngineeringPrepareResult> {
    let state = initial;
    while (state.ordinal <= 4096) {
      const reservation = await reserveContext(this.config.contextBudget, {
        operation: operationFor(state),
        ordinal: state.ordinal,
        expectedEpoch: state.budgetEpoch,
        bindings: contextBindingsFor(state),
      });
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
        targets: state.input.targets,
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
    if (state.prepared === null)
      return this.fail(state, "SOURCE_ENGINEERING_REJECTED");
    const prepared = state.prepared;
    if (state.assurance === null)
      return this.fail(state, "CHANGE_ASSURANCE_REJECTED");
    const assurance = state.assurance;
    const preview = createPreview(
      prepared.receipt,
      assurance.receipt,
      state.integrations,
    );
    const evidenceBytes = createEvidenceBytes({
      contextReceiptDigest: state.context.receipt.receiptDigest,
      baselineDigest: state.baseline.baselineDigest,
      preview,
      sourceReceipt: prepared.receipt,
      validationProfile: Object.freeze({
        id: state.input.profile.id,
        commandProfileIds: state.input.profile.commandProfileIds,
        negativeTestCommands: state.input.profile.negativeTestCommands,
      }),
    });
    if (evidenceBytes === undefined)
      return this.fail(state, "ENGINEERING_EVIDENCE_REJECTED");
    const evidence = issueWorkflowEvidence(
      evidenceBytes,
      async () =>
        (await verifyPrepared(this.config, prepared)) &&
        verifyAssurance(this.config.changeAssurance, assurance),
    );
    if (evidence === undefined)
      return this.fail(state, "ENGINEERING_EVIDENCE_REJECTED");
    const result = await this.causal.prepare({
      request: state.input.request,
      repository: state.input.repository,
      targets: prepared.artifacts.map((artifact, index) => ({
        path: artifact.path,
        operation: "write",
        candidateBytes: prepared.candidateBytes[index],
      })),
      discoveryRoot: this.config.discoveryRoot,
      commands: Object.freeze([
        ...state.input.profile.commandProfileIds,
        ...state.input.profile.negativeTestCommands.map(
          ({ profileId }) => profileId,
        ),
      ]),
      baseline: state.baseline,
      engineeringEvidence: evidence,
    });
    if (result.status !== "awaiting-approval") return result;
    if (!negativeTestEvidenceMatches(state, result.review.commandAudits)) {
      const cleanup = await this.causal.reject({ review: result.review });
      if (cleanup.status === "cleanup-pending") return cleanup;
      return {
        status: "rejected",
        code: "ENGINEERING_EVIDENCE_REJECTED",
        cleanup: cleanup.cleanup,
      };
    }
    const review: EngineeringReview = Object.freeze({
      ...result.review,
      preview,
    });
    reviews.set(review, { phase2: result.review });
    return { status: "awaiting-approval", review };
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

function rejected(
  code: import("./contract.ts").EngineeringFailureCode,
): EngineeringPrepareResult {
  return { status: "rejected", code, cleanup: null };
}

function reviewRecord(value: unknown): ReviewRecord | undefined {
  return typeof value === "object" && value !== null
    ? reviews.get(value)
    : undefined;
}

function sourceRepository(
  config: EngineeringWorkflowConfig,
  repository: ParsedDescribeInput["repository"],
) {
  return Object.freeze({
    id: repository.repositoryId,
    rootIdentity: config.causal.publicationIdentity.rootIdentity,
    treeDigest: repository.treeDigest,
    configDigest: repository.contextDigest,
  });
}

function describeBindings(input: ParsedDescribeInput): ContextBindings {
  const baselineDigest = digestValue({
    treeDigest: input.repository.treeDigest,
    targets: input.targets,
  });
  return Object.freeze({
    requestDigest: input.request.intentDigest,
    repositoryId: input.repository.repositoryId,
    treeDigest: input.repository.treeDigest,
    baselineDigest,
    provenanceDigest: digestValue({
      profile: input.profile.id,
      stage: "describe",
    }),
    candidateDigest: baselineDigest,
    cursorDigest: digestValue({ stage: "describe", targets: input.targets }),
  });
}

function matchesContext(
  result: Extract<
    Awaited<ReturnType<typeof describeSourceEngineering>>,
    { status: "described" }
  >,
  input: ParsedDescribeInput,
  config: EngineeringWorkflowConfig,
): boolean {
  const expectedTargetSet = digestValue(input.targets);
  return (
    result.receipt.requestDigest === input.request.intentDigest &&
    result.receipt.repositoryId === input.repository.repositoryId &&
    result.receipt.rootIdentity ===
      config.causal.publicationIdentity.rootIdentity &&
    result.receipt.treeDigest === input.repository.treeDigest &&
    result.receipt.configDigest === input.repository.contextDigest &&
    result.receipt.targetSetDigest === expectedTargetSet &&
    result.context.templates.every(
      ({ language }) => language === input.profile.language,
    ) &&
    result.context.targets.length === input.targets.length &&
    result.context.targets.every(
      (target, index) => target.path === input.targets[index],
    )
  );
}

function matchesPreparation(
  context: PreparationContext,
  input: ParsedEngineeringInput,
): boolean {
  return (
    context.input.request === input.request &&
    context.input.repository === input.repository &&
    context.input.profile.id === input.profile.id &&
    context.input.profile.language === input.profile.language &&
    context.input.targets.length === input.targets.length &&
    context.input.targets.every(
      (path, index) => path === input.targets[index]?.path,
    )
  );
}
