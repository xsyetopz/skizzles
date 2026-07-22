// biome-ignore-all lint: routing contracts are public API declarations.

export type RoutingCandidate = Readonly<{
  id: string;
  model: string;
  reasoningEffort?: RoutingReasoningEffort;
  prior?: Readonly<{ aaii?: number; price?: number }>;
}>;
export type RoutingReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
export type RoutingAssignmentMethod =
  | "prior"
  | "randomized"
  | "exploration"
  | "exploitation"
  | "manual"
  | "observational";
export type RoutingTaskProfile = Readonly<{
  family: string;
  complexity: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  horizon: "short" | "medium" | "long";
  topology: "single-agent" | "multi-agent";
  decomposition?: "sequential" | "parallel" | "hybrid";
  agentCount?: number;
  parallelism?: number;
  contextStrategy?: "minimal" | "shared" | "duplicated" | "isolated";
  roleIdentifiers?: readonly string[];
}>;
export type RoutingUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}>;
export type RoutingOverhead = Readonly<{
  accounting: "external-and-disjoint-from-model-usage-v1";
  duplicatedContextTokens: number;
  repeatedRepositoryReadTokens: number;
  reprocessedToolResultTokens: number;
  coordinatorTokens: number;
  reviewTokens: number;
  correctionTokens: number;
  retryTokens: number;
  failedLoopTokens: number;
  escalationTokens: number;
  replacementTokens: number;
}>;
export type RoutingStage = Readonly<{
  stage: string;
  role: string;
  model: string;
  reasoningEffort: RoutingReasoningEffort;
  dispatchRequestDigest: string;
  usage: RoutingUsage;
}>;
export type RoutingAttempts = Readonly<{
  retries: number;
  failedLoops: number;
  escalations: number;
  replacements: number;
  followUps: number;
  latencyMs: number;
}>;
export type RoutingVerification = Readonly<{
  deterministicChecks: boolean;
  runtimeSmoke: boolean;
  independentReview: boolean;
  rootRescue: boolean;
}>;
export type RoutingObservation = Readonly<{
  id: string;
  taskId: string;
  runId: string;
  runtimeReceiptDigest: string;
  dispatchRequestDigests: readonly string[];
  candidateId: string;
  task: RoutingTaskProfile;
  usage: RoutingUsage;
  overhead: RoutingOverhead;
  stages: readonly RoutingStage[];
  attempts: RoutingAttempts;
  firstPassCompletion: boolean;
  terminalCompletion: boolean;
  verification: RoutingVerification;
  independentlyVerified: boolean;
  assignment: Readonly<{
    candidateSetDigest: string;
    candidateSet: readonly string[];
    assignmentMethod: RoutingAssignmentMethod;
    experimentId: string;
    policyRevision: string;
    safetyFloor: string;
    eligibilityDigest: string;
    propensity: number;
    seed?: string;
  }>;
}>;
export type RoutingArmSummary = Readonly<{
  candidate: RoutingCandidate;
  strata: string;
  samples: number;
  successes: number;
  failures: number;
  firstPassCompletions: number;
  verificationRate: number;
  verificationLowerBound: number;
  workflowTokens: number;
  expectedTokensPerSuccess: number | null;
  candidateSetCoverage: number;
  meanLatencyMs: number;
  totalRetries: number;
  totalEscalations: number;
  totalFollowUps: number;
}>;
export type RoutingRecommendation = Readonly<{
  candidate: RoutingCandidate;
  strata: string;
  reason: "empirical";
  evidence: Readonly<{
    samples: number;
    successes: number;
    candidateSetCoverage: number;
    verificationLowerBound: number;
  }>;
}>;
