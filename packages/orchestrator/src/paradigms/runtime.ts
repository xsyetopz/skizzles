// biome-ignore lint/style/noExcessiveLinesPerFile: this module is the single causal composition boundary for all Phase 7 capabilities.
import type {
  ReflexionMemorySnapshot,
  ReflexionPersistenceReceipt,
} from "@skizzles/reflexion-memory";
import { type Digest, digestValue } from "../digest.ts";
import type { EngineeringContext } from "../engineering/contract.ts";
import { snapshotRecord } from "../engineering/snapshot.ts";
import type {
  ContextFragment,
  OutboundContextPayload,
} from "./context/contract.ts";
import { createContextFragment } from "./context/fragment.ts";
import type {
  AgentlessAdvanceResult,
  ExecutionObservation,
  ReActAdvanceResult,
} from "./execution/contract.ts";
import { createModelDispatchRequest } from "./model-dispatch.ts";
import {
  createRoutingExperimentEvent,
  type RoutingExperimentObserver,
} from "./routing-observer.ts";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  AgentRuntimeCreationResult,
  AgentRuntimeReceipt,
  AgentRuntimeRunRequest,
  AgentRuntimeRunResult,
} from "./runtime-contract.ts";
import {
  parseAgentRuntimeConfig,
  parseAgentRuntimeRunRequest,
} from "./runtime-input.ts";

interface RunEvidence {
  readonly snapshot: ReflexionMemorySnapshot | null;
  readonly payload: OutboundContextPayload | null;
  readonly dispatchDigests: readonly Digest[];
  readonly executionId: Digest | null;
  readonly engineeringEvidenceDigest: Digest | null;
}

interface ExecutionOutcome {
  readonly status: "completed" | "failed";
  readonly code: string | null;
  readonly executionId: Digest | null;
  readonly dispatchDigests: readonly Digest[];
  readonly proposal: unknown;
}

const runtimes = new WeakSet<object>();

export function createAgentRuntime(input: unknown): AgentRuntimeCreationResult {
  const config = parseAgentRuntimeConfig(input);
  if (config === undefined) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_AGENT_RUNTIME_CONFIG" as const,
    });
  }
  const runtime: AgentRuntime = Object.freeze({
    schema: "skizzles.orchestrator/agent-runtime/v1" as const,
    defaultMode: "agentless" as const,
    run: (value: unknown) => run(config, value),
    schedule: (value: unknown) => config.scheduler.run(value),
    verifySchedule: (value: unknown) => config.scheduler.verify(value),
    approveAndPromote: (value: unknown) =>
      config.engineering.approveAndPromote(value),
    reject: (value: unknown) => config.engineering.reject(value),
    recover: (value: unknown) => config.engineering.recover(value),
    retryCleanup: (value: unknown) => config.engineering.retryCleanup(value),
    resetContext: (value: unknown) => config.engineering.resetContext(value),
    resumeContextReset: (value: unknown) =>
      config.engineering.resumeContextReset(value),
  });
  runtimes.add(runtime);
  return Object.freeze({ status: "created" as const, runtime });
}

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === "object" && value !== null && runtimes.has(value);
}

async function run(
  config: AgentRuntimeConfig,
  input: unknown,
): Promise<AgentRuntimeRunResult> {
  const request = parseAgentRuntimeRunRequest(input);
  if (request === undefined) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_AGENT_RUNTIME_INPUT" as const,
    });
  }
  if (request.mode === "react" && config.react === undefined) {
    return Object.freeze({
      status: "rejected" as const,
      code: "REACT_NOT_CONFIGURED" as const,
    });
  }
  let snapshot: ReflexionMemorySnapshot;
  try {
    snapshot = await config.memoryQuery.snapshot({
      currentTaskId: request.taskId,
      currentRunId: request.runId,
    });
  } catch {
    return await failed(
      config,
      request,
      "MEMORY_READ_FAILED",
      {
        snapshot: null,
        payload: null,
        dispatchDigests: Object.freeze([]),
        executionId: null,
        engineeringEvidenceDigest: null,
      },
      false,
    );
  }
  const described = await config.engineering.describe({
    request: request.request,
    repository: request.repository,
    targets: request.targets,
    validationProfile: request.validationProfile,
  });
  if (described.status !== "described") {
    return await failed(
      config,
      request,
      "ENGINEERING_DESCRIBE_REJECTED",
      {
        snapshot,
        payload: null,
        dispatchDigests: Object.freeze([]),
        executionId: null,
        engineeringEvidenceDigest: null,
      },
      false,
    );
  }
  const fragments = withProtectedContext(
    request.supportingFragments,
    config.specifications.fragments(),
    described.context,
    snapshot,
  );
  if (fragments === undefined) {
    return await failed(
      config,
      request,
      "MEMORY_CONTEXT_REJECTED",
      {
        snapshot,
        payload: null,
        dispatchDigests: Object.freeze([]),
        executionId: null,
        engineeringEvidenceDigest: null,
      },
      false,
    );
  }
  const built = config.context.build(Object.freeze({ fragments }));
  if (
    built.status !== "built" ||
    !config.context.verify(Object.freeze({ fragments, payload: built.payload }))
  ) {
    return await failed(
      config,
      request,
      "CONTEXT_BUILD_FAILED",
      {
        snapshot,
        payload: null,
        dispatchDigests: Object.freeze([]),
        executionId: null,
        engineeringEvidenceDigest: null,
      },
      false,
    );
  }
  const outcome =
    request.mode === "agentless"
      ? await runAgentless(config, request, snapshot, built.payload)
      : await runReAct(config, request, snapshot, built.payload);
  const evidence: RunEvidence = {
    snapshot,
    payload: built.payload,
    dispatchDigests: outcome.dispatchDigests,
    executionId: outcome.executionId,
    engineeringEvidenceDigest: null,
  };
  if (outcome.status === "failed") {
    return await failed(
      config,
      request,
      outcome.code ?? "EXECUTION_FAILED",
      evidence,
      true,
    );
  }
  const proposal = parseEngineeringProposal(outcome.proposal);
  if (proposal === undefined) {
    return await failed(
      config,
      request,
      "INVALID_ENGINEERING_PROPOSAL",
      evidence,
      true,
    );
  }
  const prepared = await config.engineering.prepare({
    request: request.request,
    repository: request.repository,
    context: described.context,
    changeDeclaration: request.changeDeclaration,
    targets: proposal.targets,
    faultDeclarations: request.faultDeclarations,
    validationProfile: request.validationProfile,
    integrations: request.integrations,
  });
  if (prepared.status !== "awaiting-approval") {
    return await failed(
      config,
      request,
      "ENGINEERING_VERIFICATION_REJECTED",
      evidence,
      true,
    );
  }
  const engineeringEvidenceDigest = digestValue({
    diffDigest: prepared.review.diffDigest,
    previewEvidenceDigest: prepared.review.preview.evidenceDigest,
    verificationGateReceiptDigest:
      prepared.review.verificationGateReceipt.receiptDigest,
  });
  const completedEvidence = { ...evidence, engineeringEvidenceDigest };
  const routing = await observeRouting(
    config,
    request,
    completedEvidence,
    null,
  );
  const receipt = issueReceipt(request, completedEvidence, null, null, routing);
  return Object.freeze({
    status: "awaiting-approval" as const,
    review: prepared.review,
    receipt,
  });
}

async function runAgentless(
  config: AgentRuntimeConfig,
  request: AgentRuntimeRunRequest,
  snapshot: ReflexionMemorySnapshot,
  payload: OutboundContextPayload,
): Promise<ExecutionOutcome> {
  const dispatch = createModelDispatchRequest({
    authorityId: config.modelDispatch.authorityId,
    taskId: request.taskId,
    runId: request.runId,
    objectiveDigest: request.objectiveDigest,
    mode: "agentless",
    step: 0,
    memorySnapshotDigest: snapshot.snapshotDigest,
    context: payload,
    observation: null,
    routingAssignment: request.routingAssignment ?? null,
  });
  let task: unknown;
  try {
    task = await config.modelDispatch.dispatch(dispatch);
  } catch {
    return executionFailure("MODEL_DISPATCH_FAILED", [dispatch.requestDigest]);
  }
  const response = snapshotRecord(task, ["task", "proposal"]);
  if (response === undefined) {
    return executionFailure("INVALID_MODEL_RESPONSE", [dispatch.requestDigest]);
  }
  const started = config.agentless.start(response["task"]);
  if (
    started.status !== "started" ||
    started.session.taskId !== request.taskId ||
    started.session.objectiveDigest !== request.objectiveDigest
  ) {
    return executionFailure("INVALID_MODEL_RESPONSE", [dispatch.requestDigest]);
  }
  let session = started.session;
  for (let transition = 0; transition < 3; transition += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Agentless stages are causally sequential.
    const advanced = await config.agentless.advance({ session });
    if (advanced.status === "advanced") {
      session = advanced.session;
      continue;
    }
    return agentlessOutcome(
      advanced,
      dispatch.requestDigest,
      response["proposal"],
    );
  }
  return executionFailure("AGENTLESS_STAGE_BUDGET_EXHAUSTED", [
    dispatch.requestDigest,
  ]);
}

async function runReAct(
  config: AgentRuntimeConfig,
  request: AgentRuntimeRunRequest,
  snapshot: ReflexionMemorySnapshot,
  payload: OutboundContextPayload,
): Promise<ExecutionOutcome> {
  const controller = config.react;
  if (controller === undefined) {
    return executionFailure("REACT_NOT_CONFIGURED", []);
  }
  const started = controller.start({
    taskId: request.taskId,
    objectiveDigest: request.objectiveDigest,
  });
  if (started.status !== "started") {
    return executionFailure("REACT_START_REJECTED", []);
  }
  let session = started.session;
  let observation: ExecutionObservation | null = null;
  const dispatchDigests: Digest[] = [];
  for (
    let dispatchOrdinal = 0;
    dispatchOrdinal <= controller.maximumSteps;
    dispatchOrdinal += 1
  ) {
    const dispatch = createModelDispatchRequest({
      authorityId: config.modelDispatch.authorityId,
      taskId: request.taskId,
      runId: request.runId,
      objectiveDigest: request.objectiveDigest,
      mode: "react",
      step: session.step,
      memorySnapshotDigest: snapshot.snapshotDigest,
      context: payload,
      observation,
      routingAssignment: request.routingAssignment ?? null,
    });
    dispatchDigests.push(dispatch.requestDigest);
    let turn: unknown;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each observation defines the next legal ReAct turn.
      turn = await config.modelDispatch.dispatch(dispatch);
    } catch {
      return executionFailure("MODEL_DISPATCH_FAILED", dispatchDigests);
    }
    const advanced = await controller.advance({ session, turn });
    if (advanced.status === "observed") {
      session = advanced.session;
      observation = advanced.observation;
      continue;
    }
    return reactOutcome(advanced, dispatchDigests);
  }
  return executionFailure("REACT_STEP_BUDGET_EXHAUSTED", dispatchDigests);
}

function agentlessOutcome(
  result: Exclude<AgentlessAdvanceResult, { status: "advanced" }>,
  dispatchDigest: Digest,
  proposal: unknown,
): ExecutionOutcome {
  if (result.status === "completed") {
    return Object.freeze({
      status: "completed",
      code: null,
      executionId: result.executionId,
      dispatchDigests: Object.freeze([dispatchDigest]),
      proposal,
    });
  }
  if (result.status === "failed") {
    return executionFailure(
      `AGENTLESS_${result.failedStage.toUpperCase()}_FAILED`,
      [dispatchDigest],
      result.executionId,
    );
  }
  return executionFailure(result.code, [dispatchDigest]);
}

function reactOutcome(
  result: Exclude<ReActAdvanceResult, { status: "observed" }>,
  dispatchDigests: readonly Digest[],
): ExecutionOutcome {
  if (result.status === "completed") {
    let proposal: unknown;
    try {
      proposal = JSON.parse(result.answer);
    } catch {
      return executionFailure("INVALID_ENGINEERING_PROPOSAL", dispatchDigests);
    }
    return Object.freeze({
      status: "completed",
      code: null,
      executionId: result.sessionId,
      dispatchDigests: Object.freeze([...dispatchDigests]),
      proposal,
    });
  }
  return executionFailure(result.code, dispatchDigests);
}

function executionFailure(
  code: string,
  dispatchDigests: readonly Digest[],
  executionId: Digest | null = null,
): ExecutionOutcome {
  return Object.freeze({
    status: "failed",
    code,
    executionId,
    dispatchDigests: Object.freeze([...dispatchDigests]),
    proposal: null,
  });
}

function withProtectedContext(
  fragments: readonly ContextFragment[],
  specifications: readonly ContextFragment[],
  context: EngineeringContext,
  snapshot: ReflexionMemorySnapshot,
): readonly ContextFragment[] | undefined {
  const contract = createContextFragment({
    id: `contract.${context.contextDigest.slice(7, 31)}`,
    kind: "contract",
    critical: true,
    priority: 100,
    content: JSON.stringify(
      context.templates.map(({ templateId, schemaDigest, schemaText }) => ({
        templateId,
        schemaDigest,
        schemaText,
      })),
    ),
  });
  const ast = createContextFragment({
    id: `ast.${context.contextDigest.slice(31, 55)}`,
    kind: "ast",
    critical: true,
    priority: 100,
    content: JSON.stringify(
      context.targets.map(({ path, baselineSemanticDigest, declarations }) => ({
        path,
        baselineSemanticDigest,
        declarations,
      })),
    ),
  });
  const memory = createContextFragment({
    id: `reflexion.${snapshot.snapshotDigest.slice(7, 31)}`,
    kind: "supporting",
    critical: false,
    priority: 100,
    content: JSON.stringify(snapshot),
  });
  if (
    contract.status !== "created" ||
    ast.status !== "created" ||
    memory.status !== "created"
  ) {
    return;
  }
  return Object.freeze([
    ...fragments,
    ...specifications,
    contract.fragment,
    ast.fragment,
    memory.fragment,
  ]);
}

async function failed(
  config: AgentRuntimeConfig,
  request: AgentRuntimeRunRequest,
  code: string,
  evidence: RunEvidence,
  recordFailure: boolean,
): Promise<AgentRuntimeRunResult> {
  const routing = await observeRouting(config, request, evidence, code);
  if (!recordFailure) {
    const receipt = issueReceipt(request, evidence, code, null, routing);
    return Object.freeze({ status: "failed" as const, code, receipt });
  }
  const baseDigest = digestValue({
    request,
    code,
    evidence: evidenceMaterial(evidence),
  });
  let persistence: ReflexionPersistenceReceipt | null = null;
  let status: "recorded" | "recording-failed" = "recording-failed";
  try {
    persistence = await config.memoryRecorder.recordFailure({
      origin: { taskId: request.taskId, runId: request.runId },
      failure: {
        kind: code,
        summary: `agent runtime terminated with ${code}`,
        evidenceDigests: Object.freeze(
          [...new Set([...evidenceDigests(evidence), baseDigest])].sort(),
        ),
      },
      critique: {
        cause: `the ${request.mode} route terminated at ${code}`,
        correction:
          "inspect the bound evidence and apply the referenced skill guidance",
        prevention:
          "retain host-owned budgets, exact schemas, and causal verification",
      },
      skillReferences: config.skillReferences,
    });
    status = "recorded";
  } catch {
    persistence = null;
  }
  const receipt = issueReceipt(
    request,
    evidence,
    code,
    {
      persistence,
      status,
    },
    routing,
  );
  return Object.freeze({ status: "failed" as const, code, receipt });
}

function issueReceipt(
  request: AgentRuntimeRunRequest,
  evidence: RunEvidence,
  failureCode: string | null,
  memory: Readonly<{
    persistence: ReflexionPersistenceReceipt | null;
    status: "recorded" | "recording-failed";
  }> | null,
  routing: RoutingObservationResult,
): AgentRuntimeReceipt {
  const body = Object.freeze({
    schema: "skizzles.orchestrator/agent-runtime-receipt/v1" as const,
    taskId: request.taskId,
    runId: request.runId,
    objectiveDigest: request.objectiveDigest,
    mode: request.mode ?? "agentless",
    memorySnapshotDigest: evidence.snapshot?.snapshotDigest ?? null,
    contextPayloadDigest: evidence.payload?.payloadDigest ?? null,
    prioritizationReceiptDigest:
      evidence.payload?.prioritization.receiptDigest ?? null,
    compressionReceiptDigest:
      evidence.payload?.compression?.receiptDigest ?? null,
    routingAssignmentDigest: request.routingAssignment
      ? request.routingAssignment.assignmentDigest
      : null,
    routingObservationDigest: routing.digest,
    routingObservationStatus: routing.status,
    dispatchRequestDigests: Object.freeze([...evidence.dispatchDigests]),
    executionId: evidence.executionId,
    outcome:
      failureCode === null ? ("completed" as const) : ("failed" as const),
    failureCode,
    failureMemoryReceipt: memory?.persistence ?? null,
    failureMemoryStatus:
      memory === null ? ("not-required" as const) : memory.status,
    engineeringEvidenceDigest: evidence.engineeringEvidenceDigest,
  });
  return Object.freeze({ ...body, receiptDigest: digestValue(body) });
}

interface RoutingObservationResult {
  readonly status: "not-configured" | "recorded" | "failed";
  readonly digest: Digest | null;
}

async function observeRouting(
  config: AgentRuntimeConfig,
  request: AgentRuntimeRunRequest,
  evidence: RunEvidence,
  failureCode: string | null,
): Promise<RoutingObservationResult> {
  const observer: RoutingExperimentObserver | undefined =
    config.routingObserver;
  if (observer === undefined) {
    return Object.freeze({ status: "not-configured" as const, digest: null });
  }
  const event = createRoutingExperimentEvent({
    taskId: request.taskId,
    runId: request.runId,
    objectiveDigest: request.objectiveDigest,
    mode: request.mode ?? "agentless",
    assignment: request.routingAssignment ?? null,
    dispatchRequestDigests: evidence.dispatchDigests,
    executionId: evidence.executionId,
    context: evidence.payload,
    outcome: failureCode === null ? "awaiting-approval" : "failed",
    failureCode,
    engineeringEvidenceDigest: evidence.engineeringEvidenceDigest,
  });
  try {
    await observer.record(event);
    return Object.freeze({
      status: "recorded" as const,
      digest: event.eventDigest,
    });
  } catch {
    return Object.freeze({
      status: "failed" as const,
      digest: event.eventDigest,
    });
  }
}

function evidenceMaterial(evidence: RunEvidence) {
  return Object.freeze({
    memorySnapshotDigest: evidence.snapshot?.snapshotDigest ?? null,
    contextPayloadDigest: evidence.payload?.payloadDigest ?? null,
    dispatchDigests: evidence.dispatchDigests,
    executionId: evidence.executionId,
    engineeringEvidenceDigest: evidence.engineeringEvidenceDigest,
  });
}

function parseEngineeringProposal(
  value: unknown,
): Readonly<{ targets: unknown }> | undefined {
  const proposal = snapshotRecord(value, ["targets"]);
  if (proposal === undefined) {
    return;
  }
  return Object.freeze({ targets: proposal["targets"] });
}

function evidenceDigests(evidence: RunEvidence): Digest[] {
  return [
    ...(evidence.snapshot === null ? [] : [evidence.snapshot.snapshotDigest]),
    ...(evidence.payload === null ? [] : [evidence.payload.payloadDigest]),
    ...evidence.dispatchDigests,
    ...(evidence.executionId === null ? [] : [evidence.executionId]),
  ];
}
