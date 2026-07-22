import {
  ArtifactRegistry,
  type FilePayloadResult,
  type OutputBoundary,
  type OutputResult,
} from "./artifact.ts";
import {
  CheckpointLedger,
  type CheckpointResult,
  type CheckpointValidation,
} from "./checkpoint.ts";
import { exactKeys, isRecord } from "./codec.ts";
import { type DiagnosticResult, interceptDiagnostic } from "./diagnostic.ts";
import { type IntentResult, normalizeRequest } from "./intent.ts";
import { PreflightEngine, type PreflightResult } from "./preflight.ts";
import type { EffectClassificationAuthorityPort } from "./repository.ts";
import { classifyEffect } from "./repository.ts";
import {
  type ProposalResult,
  type ReviewResult,
  type StructuralResult,
  StructuralReview,
} from "./review.ts";
import {
  type ApprovalCancelResult,
  ApprovalController,
  type ApprovalTransitionResult,
  type PromotionResult,
} from "./state/approval.ts";
import {
  type NonEffectSpawnPort,
  type OrchestratorConfig,
  parseOrchestratorConfig,
} from "./state/configuration.ts";
import {
  DiscoveryController,
  type DiscoveryResult,
} from "./state/discovery.ts";
import {
  ExecutionBudgetController,
  type ExecutionCompletionResult,
  type ExecutionRecordResult,
  type ExecutionStartResult,
  type ExecutionTerminationResult,
} from "./state/execution.ts";
import {
  TargetBaselineManager,
  type TargetBaselineResult,
  type TargetReleaseResult,
  type TargetRevalidation,
} from "./state/target.ts";

export type RunResult =
  | { readonly status: "completed"; readonly output: OutputBoundary }
  | Exclude<IntentResult, { readonly status: "accepted" }>
  | Exclude<PreflightResult, { readonly status: "accepted" }>
  | Exclude<OutputResult, { readonly status: "accepted" }>
  | {
      readonly status: "rejected";
      readonly code:
        | "EFFECT_CLASSIFICATION_REJECTED"
        | "SPAWN_REJECTED"
        | "STRUCTURAL_REVIEW_REQUIRED";
    };

export interface Orchestrator {
  normalize(input: unknown): IntentResult;
  preflight(input: unknown): Promise<PreflightResult>;
  run(input: unknown): Promise<RunResult>;
  composeOutput(input: unknown): Promise<OutputResult>;
  createDiagnostic(input: unknown): Promise<DiagnosticResult>;
  createFilePayload(input: unknown): FilePayloadResult;
  createCheckpoint(input: unknown): Promise<CheckpointResult>;
  supersedeCheckpoint(input: unknown): Promise<CheckpointResult>;
  validateCheckpoint(input: unknown): Promise<CheckpointValidation>;
  proposeChange(input: unknown): ProposalResult;
  reviewChange(input: unknown): Promise<ReviewResult>;
  applyChange(input: unknown): Promise<StructuralResult>;
  captureTargetBaseline(input: unknown): Promise<TargetBaselineResult>;
  revalidateTargetBaseline(input: unknown): Promise<TargetRevalidation>;
  releaseTargetBaseline(input: unknown): TargetReleaseResult;
  startExecution(input: unknown): ExecutionStartResult;
  recordExecution(input: unknown): ExecutionRecordResult;
  terminateExecution(input: unknown): ExecutionTerminationResult;
  completeExecution(input: unknown): Promise<ExecutionCompletionResult>;
  discover(input: unknown): Promise<DiscoveryResult>;
  expandDiscovery(input: unknown): Promise<DiscoveryResult>;
  planApproval(input: unknown): ApprovalTransitionResult;
  reviewApproval(input: unknown): ApprovalTransitionResult;
  awaitApproval(input: unknown): ApprovalTransitionResult;
  approve(input: unknown): Promise<ApprovalTransitionResult>;
  promote(input: unknown): Promise<PromotionResult>;
  cancelApproval(input: unknown): ApprovalCancelResult;
}

export type OrchestratorResult =
  | { readonly status: "accepted"; readonly orchestrator: Orchestrator }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_ORCHESTRATOR_CONFIG";
    };

export function createOrchestrator(input: unknown): OrchestratorResult {
  let config: OrchestratorConfig | undefined;
  try {
    config = parseOrchestratorConfig(input);
  } catch {
    return { status: "rejected", code: "INVALID_ORCHESTRATOR_CONFIG" };
  }
  if (config === undefined) {
    return { status: "rejected", code: "INVALID_ORCHESTRATOR_CONFIG" };
  }
  const artifacts = new ArtifactRegistry(
    config.artifactValidators,
    config.outputCaps.tokens,
    config.outputCaps.bytes,
    config.diagnosticInterceptor,
  );
  const preflight = new PreflightEngine(
    config.repositoryAuthority,
    config.graph,
    new Set(config.requiredInvariants),
  );
  const checkpoints = new CheckpointLedger(config.verificationAuthority);
  const structural = new StructuralReview(
    config.measurementAuthority,
    config.structural,
  );
  const targets = new TargetBaselineManager(config.targetAuthority);
  const executions = new ExecutionBudgetController(
    config.clock,
    config.completionAuthority,
    config.executionBudgets,
    config.completionContract.id,
    config.completionContract.checks,
  );
  const discovery = new DiscoveryController(
    config.discoveryAuthority,
    config.clock,
    config.discoveryPolicy,
  );
  const approvals = new ApprovalController(
    config.approvalAuthority,
    config.clock,
    targets,
    config.approvalTtlMs,
  );
  const orchestrator: Orchestrator = Object.freeze({
    normalize: (value: unknown) => safeIntent(value),
    preflight: (value: unknown) =>
      safeAsync(() => preflight.evaluate(value), {
        status: "rejected",
        code: "INVALID_PREFLIGHT_INPUT",
        issues: Object.freeze(["invalid-input"]),
      }),
    run: (value: unknown) =>
      safeAsync(
        () =>
          run(
            value,
            preflight,
            config.effectClassificationAuthority,
            config.nonEffectSpawn,
            artifacts,
          ),
        {
          status: "rejected",
          code: "INVALID_REQUEST_ENVELOPE",
        },
      ),
    composeOutput: (value: unknown) =>
      safeAsync(() => artifacts.compose(value), {
        status: "rejected",
        code: "INVALID_OUTPUT",
      }),
    createDiagnostic: (value: unknown) =>
      safeAsync(
        () => interceptDiagnostic(value, config.diagnosticInterceptor),
        {
          status: "rejected",
          code: "INVALID_DIAGNOSTIC",
        },
      ),
    createFilePayload: (value: unknown) => safeFilePayload(value, artifacts),
    createCheckpoint: (value: unknown) =>
      safeAsync(() => checkpoints.create(value), {
        status: "rejected",
        code: "INVALID_CHECKPOINT_INPUT",
      }),
    supersedeCheckpoint: (value: unknown) =>
      safeAsync(() => checkpoints.supersede(value), {
        status: "rejected",
        code: "INVALID_CHECKPOINT_INPUT",
      }),
    validateCheckpoint: (value: unknown) =>
      safeAsync(() => checkpoints.validate(value), {
        status: "invalid",
        code: "INVALID_CHECKPOINT_INPUT",
      }),
    proposeChange: (value: unknown) => safeProposal(value, structural),
    reviewChange: (value: unknown) =>
      safeAsync(() => structural.review(value), {
        status: "rejected",
        code: "INVALID_STRUCTURAL_PROPOSAL",
      }),
    applyChange: (value: unknown) =>
      safeAsync(() => structural.apply(value), {
        status: "rejected",
        code: "ADVERSARIAL_REVIEW_REQUIRED",
      }),
    captureTargetBaseline: (value: unknown) =>
      safeAsync(() => targets.capture(value), {
        status: "rejected",
        code: "INVALID_TARGET_INPUT",
      }),
    revalidateTargetBaseline: (value: unknown) =>
      safeAsync(() => targets.revalidate(value), {
        status: "rejected",
        code: "INVALID_TARGET_BASELINE",
      }),
    releaseTargetBaseline: (value: unknown) =>
      safeTargetRelease(value, targets),
    startExecution: (value: unknown) => safeExecutionStart(value, executions),
    recordExecution: (value: unknown) => safeExecutionRecord(value, executions),
    terminateExecution: (value: unknown) =>
      safeExecutionTermination(value, executions),
    completeExecution: (value: unknown) =>
      safeAsync(() => executions.complete(value), {
        status: "rejected",
        code: "INVALID_EXECUTION_COMPLETION",
      }),
    discover: (value: unknown) =>
      safeAsync(() => discovery.discover(value), {
        status: "rejected",
        code: "INVALID_DISCOVERY_INPUT",
      }),
    expandDiscovery: (value: unknown) =>
      safeAsync(() => discovery.expand(value), {
        status: "rejected",
        code: "INVALID_DISCOVERY_INPUT",
      }),
    planApproval: (value: unknown) => safeApprovalPlan(value, approvals),
    reviewApproval: (value: unknown) => safeApprovalReview(value, approvals),
    awaitApproval: (value: unknown) => safeApprovalAwait(value, approvals),
    approve: (value: unknown) =>
      safeAsync(() => approvals.approve(value), {
        status: "rejected",
        code: "INVALID_APPROVAL_INPUT",
      }),
    promote: (value: unknown) =>
      safeAsync(() => approvals.promote(value), {
        status: "rejected",
        code: "INVALID_APPROVAL_INPUT",
      }),
    cancelApproval: (value: unknown) => safeApprovalCancel(value, approvals),
  });
  return { status: "accepted", orchestrator };
}

function safeTargetRelease(
  value: unknown,
  targets: TargetBaselineManager,
): TargetReleaseResult {
  try {
    return targets.release(value);
  } catch {
    return { status: "rejected", code: "INVALID_TARGET_BASELINE" };
  }
}

function safeExecutionStart(
  value: unknown,
  executions: ExecutionBudgetController,
): ExecutionStartResult {
  try {
    return executions.start(value);
  } catch {
    return { status: "rejected", code: "INVALID_EXECUTION_INPUT" };
  }
}

function safeExecutionRecord(
  value: unknown,
  executions: ExecutionBudgetController,
): ExecutionRecordResult {
  try {
    return executions.record(value);
  } catch {
    return { status: "rejected", code: "INVALID_EXECUTION_EVENT" };
  }
}

function safeExecutionTermination(
  value: unknown,
  executions: ExecutionBudgetController,
): ExecutionTerminationResult {
  try {
    return executions.terminate(value);
  } catch {
    return { status: "rejected", code: "INVALID_EXECUTION_TERMINATION" };
  }
}

function safeApprovalPlan(
  value: unknown,
  approvals: ApprovalController,
): ApprovalTransitionResult {
  try {
    return approvals.plan(value);
  } catch {
    return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
  }
}

function safeApprovalReview(
  value: unknown,
  approvals: ApprovalController,
): ApprovalTransitionResult {
  try {
    return approvals.review(value);
  } catch {
    return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
  }
}

function safeApprovalAwait(
  value: unknown,
  approvals: ApprovalController,
): ApprovalTransitionResult {
  try {
    return approvals.awaitApproval(value);
  } catch {
    return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
  }
}

function safeApprovalCancel(
  value: unknown,
  approvals: ApprovalController,
): ApprovalCancelResult {
  try {
    return approvals.cancel(value);
  } catch {
    return { status: "rejected", code: "INVALID_APPROVAL_INPUT" };
  }
}

function safeIntent(value: unknown): IntentResult {
  try {
    return normalizeRequest(value);
  } catch {
    return { status: "rejected", code: "INVALID_REQUEST_ENVELOPE" };
  }
}

function safeFilePayload(
  value: unknown,
  artifacts: ArtifactRegistry,
): FilePayloadResult {
  try {
    return artifacts.filePayload(value);
  } catch {
    return { status: "rejected", code: "UNVERIFIED_ARTIFACT" };
  }
}

function safeProposal(
  value: unknown,
  review: StructuralReview,
): ProposalResult {
  try {
    return review.propose(value);
  } catch {
    return { status: "rejected", code: "INVALID_STRUCTURAL_PROPOSAL" };
  }
}

async function safeAsync<Result>(
  operation: () => Promise<Result>,
  fallback: Result,
): Promise<Result> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

async function run(
  input: unknown,
  engine: PreflightEngine,
  effectAuthority: EffectClassificationAuthorityPort,
  spawn: NonEffectSpawnPort,
  artifacts: ArtifactRegistry,
): Promise<RunResult> {
  if (!(isRecord(input) && exactKeys(input, ["rawRequest", "repository"]))) {
    return { status: "rejected", code: "INVALID_REQUEST_ENVELOPE" };
  }
  const normalized = normalizeRequest(input.rawRequest);
  if (normalized.status === "rejected") return normalized;
  const captured = await engine.capture(normalized.request, input.repository);
  if (captured.status === "rejected") {
    return {
      status: "rejected",
      code: captured.code,
      issues: Object.freeze(["repository-authority"]),
    };
  }
  const classified = await classifyEffect(
    effectAuthority,
    normalized.request,
    captured.context,
  );
  if (classified.status === "rejected") return classified;
  if (classified.classification.effect === "structural") {
    return { status: "rejected", code: "STRUCTURAL_REVIEW_REQUIRED" };
  }
  const decision = await engine.evaluateCaptured(
    normalized.request,
    captured.context,
  );
  if (decision.status !== "accepted") return decision;
  let rawOutput: unknown;
  try {
    rawOutput = await spawn.spawn(
      Object.freeze({
        effect: "none",
        request: normalized.request,
        repository: decision.approval.repository,
        preflight: decision.approval,
        classification: classified.classification,
      }),
    );
  } catch {
    return { status: "rejected", code: "SPAWN_REJECTED" };
  }
  const output = await artifacts.compose(rawOutput);
  if (output.status === "rejected") return output;
  return { status: "completed", output: output.output };
}
