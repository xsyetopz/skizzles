import {
  ArtifactRegistry,
  type ArtifactValidator,
  type FilePayloadResult,
  type OutputBoundary,
  type OutputResult,
} from "./artifact.ts";
import {
  CheckpointLedger,
  type CheckpointResult,
  type CheckpointValidation,
  type VerificationAuthorityPort,
} from "./checkpoint.ts";
import { exactKeys, isRecord, nonempty, stringArray } from "./codec.ts";
import {
  type DiagnosticInterceptor,
  type DiagnosticResult,
  interceptDiagnostic,
} from "./diagnostic.ts";
import {
  type IntentResult,
  type NormalizedRequest,
  normalizeRequest,
} from "./intent.ts";
import {
  type PreflightApproval,
  PreflightEngine,
  type PreflightResult,
  type RepositoryGraphPort,
} from "./preflight.ts";
import type {
  EffectClassification,
  EffectClassificationAuthorityPort,
  RepositoryAuthorityPort,
  RepositoryContext,
} from "./repository.ts";
import { classifyEffect } from "./repository.ts";
import {
  type MeasurementAuthorityPort,
  type ProposalResult,
  type ReviewResult,
  type StructuralPort,
  type StructuralResult,
  StructuralReview,
} from "./review.ts";

export interface NonEffectSpawnPort {
  spawn(input: {
    readonly effect: "none";
    readonly request: NormalizedRequest;
    readonly repository: RepositoryContext;
    readonly preflight: PreflightApproval;
    readonly classification: EffectClassification;
  }): unknown | Promise<unknown>;
}

export interface OrchestratorConfig {
  readonly repositoryAuthority: RepositoryAuthorityPort;
  readonly effectClassificationAuthority: EffectClassificationAuthorityPort;
  readonly graph: RepositoryGraphPort;
  readonly measurementAuthority: MeasurementAuthorityPort;
  readonly verificationAuthority: VerificationAuthorityPort;
  readonly nonEffectSpawn: NonEffectSpawnPort;
  readonly structural: StructuralPort;
  readonly artifactValidators: readonly ArtifactValidator[];
  readonly requiredInvariants: readonly string[];
  readonly outputCaps: {
    readonly tokens: number;
    readonly bytes: number;
  };
  readonly diagnosticInterceptor?: DiagnosticInterceptor;
}

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
    config = parseConfig(input);
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
  });
  return { status: "accepted", orchestrator };
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

function parseConfig(input: unknown): OrchestratorConfig | undefined {
  if (
    !isRecord(input) ||
    !exactKeys(
      input,
      [
        "repositoryAuthority",
        "effectClassificationAuthority",
        "graph",
        "measurementAuthority",
        "verificationAuthority",
        "nonEffectSpawn",
        "structural",
        "artifactValidators",
        "requiredInvariants",
        "outputCaps",
      ],
      ["diagnosticInterceptor"],
    ) ||
    !isRecord(input.outputCaps) ||
    !exactKeys(input.outputCaps, ["tokens", "bytes"]) ||
    typeof input.outputCaps.tokens !== "number" ||
    typeof input.outputCaps.bytes !== "number"
  ) {
    return;
  }
  const repositoryCapture = method(input.repositoryAuthority, "capture");
  const effectClassify = method(
    input.effectClassificationAuthority,
    "classify",
  );
  const graphInspect = method(input.graph, "inspect");
  const measure = method(input.measurementAuthority, "measure");
  const verificationCapture = method(input.verificationAuthority, "capture");
  const spawn = method(input.nonEffectSpawn, "spawn");
  const apply = method(input.structural, "apply");
  const validators = ArtifactRegistry.parseValidators(
    input.artifactValidators,
    input.outputCaps.tokens,
    input.outputCaps.bytes,
  );
  const requiredInvariants = stringArray(input.requiredInvariants);
  const interceptor = Object.hasOwn(input, "diagnosticInterceptor")
    ? method(input.diagnosticInterceptor, "intercept")
    : undefined;
  if (
    repositoryCapture === undefined ||
    effectClassify === undefined ||
    graphInspect === undefined ||
    measure === undefined ||
    verificationCapture === undefined ||
    spawn === undefined ||
    apply === undefined ||
    validators === undefined ||
    requiredInvariants === undefined ||
    requiredInvariants.length === 0 ||
    requiredInvariants.some((id) => !nonempty(id, 128)) ||
    new Set(requiredInvariants).size !== requiredInvariants.length ||
    (Object.hasOwn(input, "diagnosticInterceptor") && interceptor === undefined)
  ) {
    return;
  }
  return Object.freeze({
    repositoryAuthority: { capture: repositoryCapture },
    effectClassificationAuthority: { classify: effectClassify },
    graph: { inspect: graphInspect },
    measurementAuthority: { measure },
    verificationAuthority: { capture: verificationCapture },
    nonEffectSpawn: { spawn },
    structural: { apply },
    artifactValidators: validators,
    requiredInvariants,
    outputCaps: Object.freeze({
      tokens: input.outputCaps.tokens,
      bytes: input.outputCaps.bytes,
    }),
    ...(interceptor === undefined
      ? {}
      : { diagnosticInterceptor: { intercept: interceptor } }),
  });
}

function method(
  value: unknown,
  name: string,
): ((input: unknown) => unknown | Promise<unknown>) | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, [name]) ||
    typeof value[name] !== "function"
  ) {
    return;
  }
  const implementation = value[name];
  return (input: unknown) => Reflect.apply(implementation, value, [input]);
}
