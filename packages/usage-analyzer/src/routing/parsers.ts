// biome-ignore-all lint: parser helpers are public API declarations.

import type {
  RoutingAssignmentMethod,
  RoutingAttempts,
  RoutingCandidate,
  RoutingObservation,
  RoutingOverhead,
  RoutingReasoningEffort,
  RoutingStage,
  RoutingTaskProfile,
  RoutingUsage,
  RoutingVerification,
} from "./contracts.ts";

const freeze = <T extends object>(value: T): Readonly<T> =>
  Object.freeze(value);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const finite = (value: unknown, name: string, integer = false): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error(
      `${name} must be a finite non-negative ${integer ? "integer" : "number"}`,
    );
  return value;
};
const text = (value: unknown, name: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /prompt|path|title|secret|credential|token/i.test(name)
  )
    throw new Error(`${name} must be a bounded privacy-safe string`);
  return value;
};
const object = (
  value: unknown,
  name: string,
  allowed: readonly string[],
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  const entries = Object.entries(value);
  if (entries.some(([key]) => !allowed.includes(key)))
    throw new Error(`${name} contains an unknown field`);
  if (
    entries.some(([key]) =>
      /prompt|path|title|secret|credential|password|raw.?data/i.test(key),
    )
  )
    throw new Error(`${name} contains privacy-sensitive raw data`);
  return Object.fromEntries(entries);
};
export function parseRoutingCandidate(value: unknown): RoutingCandidate {
  const input = object(value, "candidate", [
    "id",
    "model",
    "reasoningEffort",
    "prior",
  ]);
  const id = text(input["id"], "candidate id");
  const model = text(input["model"], "candidate model");
  const reasoningEffort = parseEffort(input["reasoningEffort"]);
  const priorInput = input["prior"];
  let prior: { aaii?: number; price?: number } | undefined;
  if (priorInput !== undefined) {
    const p = object(priorInput, "candidate prior", ["aaii", "price"]);
    const result: { aaii?: number; price?: number } = {};
    if (p["aaii"] !== undefined) result.aaii = finite(p["aaii"], "prior aaii");
    if (p["price"] !== undefined)
      result.price = finite(p["price"], "prior price");
    prior = result;
  }
  return freeze({
    id,
    model,
    reasoningEffort,
    ...(prior ? { prior: freeze(prior) } : {}),
  });
}
export function parseRoutingTaskProfile(value: unknown): RoutingTaskProfile {
  const input = object(value, "task profile", [
    "family",
    "complexity",
    "risk",
    "horizon",
    "topology",
    "decomposition",
    "agentCount",
    "parallelism",
    "contextStrategy",
    "roleIdentifiers",
  ]);
  const choose = <T extends string>(key: string, allowed: readonly T[]): T => {
    const item = input[key];
    if (typeof item !== "string") throw new Error(`invalid task ${key}`);
    const selected = allowed.find((candidate) => candidate === item);
    if (selected === undefined) throw new Error(`invalid task ${key}`);
    return selected;
  };
  const complexity = choose("complexity", ["low", "medium", "high"]);
  const risk = choose("risk", ["low", "medium", "high"]);
  const horizon = choose("horizon", ["short", "medium", "long"]);
  const topology = choose("topology", ["single-agent", "multi-agent"]);
  const decomposition =
    input["decomposition"] === undefined
      ? "sequential"
      : choose("decomposition", ["sequential", "parallel", "hybrid"]);
  const contextStrategy =
    input["contextStrategy"] === undefined
      ? "shared"
      : choose("contextStrategy", [
          "minimal",
          "shared",
          "duplicated",
          "isolated",
        ]);
  const agentCount =
    input["agentCount"] === undefined
      ? 1
      : finite(input["agentCount"], "agentCount", true);
  const parallelism =
    input["parallelism"] === undefined
      ? 1
      : finite(input["parallelism"], "parallelism", true);
  if (agentCount < 1 || parallelism < 1 || parallelism > agentCount)
    throw new Error("invalid workflow agentCount/parallelism");
  const roleIdentifiers =
    input["roleIdentifiers"] === undefined ? [] : input["roleIdentifiers"];
  if (
    !Array.isArray(roleIdentifiers) ||
    roleIdentifiers.length > 32 ||
    roleIdentifiers.some(
      (role) =>
        typeof role !== "string" || role.length === 0 || role.length > 64,
    )
  )
    throw new Error("invalid roleIdentifiers");
  return freeze({
    family: text(input["family"], "task family"),
    complexity:
      complexity === "low" || complexity === "medium" ? complexity : "high",
    risk: risk === "low" || risk === "medium" ? risk : "high",
    horizon: horizon === "short" || horizon === "medium" ? horizon : "long",
    topology,
    decomposition,
    agentCount,
    parallelism,
    contextStrategy:
      contextStrategy === "minimal" ||
      contextStrategy === "shared" ||
      contextStrategy === "duplicated"
        ? contextStrategy
        : "isolated",
    roleIdentifiers: Object.freeze([...roleIdentifiers]),
  });
}
function parseUsage(value: unknown): RoutingUsage {
  const input = object(value, "usage", [
    "inputTokens",
    "cachedInputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningTokens",
  ]);
  const inputTokens = finite(input["inputTokens"], "inputTokens", true);
  const cachedInputTokens = finite(
    input["cachedInputTokens"],
    "cachedInputTokens",
    true,
  );
  if (cachedInputTokens > inputTokens) {
    throw new Error("cachedInputTokens cannot exceed inputTokens");
  }
  const uncachedInputTokens =
    input["uncachedInputTokens"] === undefined
      ? inputTokens - cachedInputTokens
      : finite(input["uncachedInputTokens"], "uncachedInputTokens", true);
  if (uncachedInputTokens !== inputTokens - cachedInputTokens) {
    throw new Error(
      "uncachedInputTokens must equal inputTokens-cachedInputTokens",
    );
  }
  return freeze({
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens: finite(input["outputTokens"], "outputTokens", true),
    reasoningTokens: finite(input["reasoningTokens"], "reasoningTokens", true),
  });
}
function parseOverhead(value: unknown): RoutingOverhead {
  const input = object(value, "overhead", [
    "accounting",
    "duplicatedContextTokens",
    "repeatedRepositoryReadTokens",
    "reprocessedToolResultTokens",
    "coordinatorTokens",
    "reviewTokens",
    "correctionTokens",
    "retryTokens",
    "failedLoopTokens",
    "escalationTokens",
    "replacementTokens",
  ]);
  if (input["accounting"] !== "external-and-disjoint-from-model-usage-v1") {
    throw new Error("overhead accounting must be disjoint from model usage");
  }
  return freeze({
    accounting: "external-and-disjoint-from-model-usage-v1",
    duplicatedContextTokens: finite(
      input["duplicatedContextTokens"],
      "duplicatedContextTokens",
      true,
    ),
    repeatedRepositoryReadTokens: finite(
      input["repeatedRepositoryReadTokens"] ?? 0,
      "repeatedRepositoryReadTokens",
      true,
    ),
    reprocessedToolResultTokens: finite(
      input["reprocessedToolResultTokens"] ?? 0,
      "reprocessedToolResultTokens",
      true,
    ),
    coordinatorTokens: finite(
      input["coordinatorTokens"],
      "coordinatorTokens",
      true,
    ),
    reviewTokens: finite(input["reviewTokens"] ?? 0, "reviewTokens", true),
    correctionTokens: finite(
      input["correctionTokens"] ?? 0,
      "correctionTokens",
      true,
    ),
    retryTokens: finite(input["retryTokens"], "retryTokens", true),
    failedLoopTokens: finite(
      input["failedLoopTokens"],
      "failedLoopTokens",
      true,
    ),
    escalationTokens: finite(
      input["escalationTokens"],
      "escalationTokens",
      true,
    ),
    replacementTokens: finite(
      input["replacementTokens"],
      "replacementTokens",
      true,
    ),
  });
}
export function workflowTokens(
  usage: RoutingUsage,
  overhead: RoutingOverhead,
): number {
  if (
    overhead.accounting !== "external-and-disjoint-from-model-usage-v1" ||
    usage.uncachedInputTokens !== usage.inputTokens - usage.cachedInputTokens
  ) {
    throw new Error("invalid routing token ledger");
  }
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.reasoningTokens +
    overhead.duplicatedContextTokens +
    overhead.repeatedRepositoryReadTokens +
    overhead.reprocessedToolResultTokens +
    overhead.coordinatorTokens +
    overhead.reviewTokens +
    overhead.correctionTokens +
    overhead.retryTokens +
    overhead.failedLoopTokens +
    overhead.escalationTokens +
    overhead.replacementTokens
  );
}
function parseStages(value: unknown): readonly RoutingStage[] {
  if (value === undefined) throw new Error("stages are required");
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("stages must be a bounded array");
  return Object.freeze(
    value.map((item) => {
      const input = object(item, "stage", [
        "stage",
        "role",
        "model",
        "reasoningEffort",
        "dispatchRequestDigest",
        "usage",
      ]);
      const effort = parseEffort(input["reasoningEffort"]);
      return freeze({
        stage: text(input["stage"], "stage identifier"),
        role: text(input["role"], "stage role"),
        model: text(input["model"], "stage model"),
        reasoningEffort: effort,
        dispatchRequestDigest: parseDigest(input["dispatchRequestDigest"]),
        usage: parseUsage(input["usage"]),
      });
    }),
  );
}
function parseEffort(value: unknown): RoutingReasoningEffort {
  const effort = value ?? "medium";
  if (
    effort === "none" ||
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max" ||
    effort === "ultra"
  ) {
    return effort;
  }
  throw new Error("invalid reasoningEffort");
}
function parseAttempts(value: unknown): RoutingAttempts {
  if (value === undefined) throw new Error("attempts are required");
  const input = object(value, "attempts", [
    "retries",
    "failedLoops",
    "escalations",
    "replacements",
    "followUps",
    "latencyMs",
  ]);
  return freeze({
    retries: finite(input["retries"] ?? 0, "retries", true),
    failedLoops: finite(input["failedLoops"] ?? 0, "failedLoops", true),
    escalations: finite(input["escalations"] ?? 0, "escalations", true),
    replacements: finite(input["replacements"] ?? 0, "replacements", true),
    followUps: finite(input["followUps"] ?? 0, "followUps", true),
    latencyMs: finite(input["latencyMs"] ?? 0, "latencyMs"),
  });
}
export function parseRoutingObservation(value: unknown): RoutingObservation {
  const input = object(value, "observation", [
    "id",
    "taskId",
    "runId",
    "runtimeReceiptDigest",
    "dispatchRequestDigests",
    "candidateId",
    "task",
    "usage",
    "overhead",
    "stages",
    "attempts",
    "firstPassCompletion",
    "terminalCompletion",
    "verification",
    "independentlyVerified",
    "assignment",
  ]);
  const assignment = object(input["assignment"], "assignment", [
    "candidateSetDigest",
    "candidateSet",
    "assignmentMethod",
    "experimentId",
    "policyRevision",
    "safetyFloor",
    "eligibilityDigest",
    "propensity",
    "seed",
  ]);
  if (typeof input["independentlyVerified"] !== "boolean")
    throw new Error("independentlyVerified must be boolean");
  const propensity = assignment["propensity"];
  if (
    typeof propensity !== "number" ||
    !Number.isFinite(propensity) ||
    propensity <= 0 ||
    propensity > 1
  )
    throw new Error("propensity must be in (0,1]");
  const assignmentMethod = parseAssignmentMethod(
    assignment["assignmentMethod"],
  );
  const verification = parseVerification(input["verification"]);
  const candidateId = text(input["candidateId"], "candidate id");
  const candidateSet = parseIdentifierList(
    assignment["candidateSet"],
    "candidate set",
  );
  if (!candidateSet.includes(candidateId)) {
    throw new Error("candidate must belong to the assigned candidate set");
  }
  const usage = parseUsage(input["usage"]);
  const stages = parseStages(input["stages"]);
  const dispatchRequestDigests = parseDigestList(
    input["dispatchRequestDigests"],
  );
  if (
    stages.some(
      (stage) => !dispatchRequestDigests.includes(stage.dispatchRequestDigest),
    )
  ) {
    throw new Error("stage dispatch digests must join the observation");
  }
  if (!usageMatchesStages(usage, stages)) {
    throw new Error("stage usage must reconcile with observation usage");
  }
  const overhead = parseOverhead(input["overhead"]);
  const attempts = parseAttempts(input["attempts"]);
  return freeze({
    id: text(input["id"], "observation id"),
    taskId: text(input["taskId"], "task id"),
    runId: text(input["runId"], "run id"),
    runtimeReceiptDigest: parseDigest(input["runtimeReceiptDigest"]),
    dispatchRequestDigests,
    candidateId,
    task: parseRoutingTaskProfile(input["task"]),
    usage,
    overhead,
    stages,
    attempts,
    firstPassCompletion: booleanField(input, "firstPassCompletion"),
    verification,
    terminalCompletion: booleanField(input, "terminalCompletion"),
    independentlyVerified: input["independentlyVerified"],
    assignment: freeze({
      candidateSetDigest: parseDigest(assignment["candidateSetDigest"]),
      candidateSet,
      assignmentMethod,
      experimentId: text(assignment["experimentId"], "experiment id"),
      policyRevision: text(assignment["policyRevision"], "policy revision"),
      safetyFloor: text(assignment["safetyFloor"], "safety floor"),
      eligibilityDigest: parseDigest(assignment["eligibilityDigest"]),
      propensity,
      ...(assignment["seed"] === undefined
        ? {}
        : { seed: text(assignment["seed"], "assignment seed") }),
    }),
  });
}

function usageMatchesStages(
  usage: RoutingUsage,
  stages: readonly RoutingStage[],
): boolean {
  const total = stages.reduce(
    (sum, stage) => ({
      inputTokens: sum.inputTokens + stage.usage.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + stage.usage.cachedInputTokens,
      uncachedInputTokens:
        sum.uncachedInputTokens + stage.usage.uncachedInputTokens,
      outputTokens: sum.outputTokens + stage.usage.outputTokens,
      reasoningTokens: sum.reasoningTokens + stage.usage.reasoningTokens,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
  );
  return (
    total.inputTokens === usage.inputTokens &&
    total.cachedInputTokens === usage.cachedInputTokens &&
    total.uncachedInputTokens === usage.uncachedInputTokens &&
    total.outputTokens === usage.outputTokens &&
    total.reasoningTokens === usage.reasoningTokens
  );
}

function parseAssignmentMethod(value: unknown): RoutingAssignmentMethod {
  const method = value ?? "observational";
  if (
    method === "prior" ||
    method === "randomized" ||
    method === "exploration" ||
    method === "exploitation" ||
    method === "manual" ||
    method === "observational"
  ) {
    return method;
  }
  throw new Error("invalid assignmentMethod");
}

function parseVerification(value: unknown): RoutingVerification {
  if (value === undefined) throw new Error("verification evidence is required");
  const input = object(value, "verification", [
    "deterministicChecks",
    "runtimeSmoke",
    "independentReview",
    "rootRescue",
  ]);
  const fields = [
    "deterministicChecks",
    "runtimeSmoke",
    "independentReview",
    "rootRescue",
  ] as const;
  if (fields.some((field) => typeof input[field] !== "boolean")) {
    throw new Error("verification stages must be boolean");
  }
  return freeze({
    deterministicChecks: booleanField(input, "deterministicChecks"),
    runtimeSmoke: booleanField(input, "runtimeSmoke"),
    independentReview: booleanField(input, "independentReview"),
    rootRescue: booleanField(input, "rootRescue"),
  });
}

function booleanField(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (typeof value !== "boolean") {
    throw new Error("verification stages must be boolean");
  }
  return value;
}

function parseDigest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error("candidate set digest must be a SHA-256 digest");
  }
  return value;
}

function parseDigestList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("dispatch digests must be a bounded array");
  }
  return Object.freeze(value.map((item) => parseDigest(item)));
}

function parseIdentifierList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new Error(`${name} must be a bounded non-empty array`);
  }
  const identifiers = value.map((item) => text(item, `${name} identifier`));
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error(`${name} identifiers must be unique`);
  }
  return Object.freeze(identifiers);
}

export { finite, freeze };
