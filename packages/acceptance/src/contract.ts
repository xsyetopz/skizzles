import type { CandidateManifestDigest } from "@skizzles/candidate-manifest";
import type { VerificationDigest } from "./digest.ts";

export type VerificationAuthorityKind =
  | "change-assurance"
  | "coverage"
  | "exclusion"
  | "mutation"
  | "original-tests"
  | "physical-evidence"
  | "property"
  | "reviewer"
  | "source-evidence"
  | "task-worktree";

export interface VerificationBindings {
  readonly taskId: string;
  readonly taskEpochDigest: VerificationDigest;
  readonly requestDigest: VerificationDigest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: VerificationDigest;
  readonly baselineDigest: VerificationDigest;
  readonly candidateDigest: VerificationDigest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly specLockDigest: VerificationDigest;
  readonly baselineManifestDigest: VerificationDigest;
}

export interface VerificationAuthorityRequest {
  readonly purpose: VerificationAuthorityKind;
  readonly bindings: VerificationBindings;
  readonly bindingDigest: VerificationDigest;
  readonly payload: unknown;
}

interface VerificationAuthorityConfig {
  readonly id: string;
  readonly evaluate: (
    request: VerificationAuthorityRequest,
  ) => unknown | Promise<unknown>;
}

export interface VerificationAuthority<K extends VerificationAuthorityKind> {
  readonly id: string;
  readonly kind: K;
}

export type SourceEvidenceAuthority = VerificationAuthority<"source-evidence">;
export type ChangeAssuranceAuthority =
  VerificationAuthority<"change-assurance">;
export type TaskWorktreeEvidenceAuthority =
  VerificationAuthority<"task-worktree">;
export type OriginalTestAuthority = VerificationAuthority<"original-tests">;
export type PhysicalEvidenceAuthority =
  VerificationAuthority<"physical-evidence">;
export type MutationEngineAuthority = VerificationAuthority<"mutation">;
export type PropertyEngineAuthority = VerificationAuthority<"property">;
export type CoverageAuthority = VerificationAuthority<"coverage">;
export type ExclusionAuthority = VerificationAuthority<"exclusion">;
export type IndependentReviewer = VerificationAuthority<"reviewer">;

export type VerificationAuthorityRegistrationConfig =
  VerificationAuthorityConfig;

export type VerificationAuthorityRegistrationResult<
  K extends VerificationAuthorityKind,
> =
  | Readonly<{ status: "created"; authority: VerificationAuthority<K> }>
  | Readonly<{ status: "rejected"; code: "INVALID_AUTHORITY_CONFIG" }>;

export interface VerificationGateLimits {
  readonly modifiedNodes: number;
  readonly linesPerNode: number;
  readonly branchesPerNode: number;
  readonly mutationSitesPerNode: number;
  readonly variantsPerSite: number;
  readonly properties: number;
  readonly artifactBytes: number;
}

export interface VerificationCoverageThresholds {
  readonly minimumNodeHits: number;
  readonly minimumLineHits: number;
  readonly minimumBranchHits: number;
}

export interface DeterministicFuzzConfig {
  readonly rootSeed: number;
  readonly seeds: number;
  readonly casesPerSeed: number;
  readonly dimensions: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly extremes: readonly number[];
}

export interface VerificationGateConfig {
  readonly authorityId: string;
  readonly sourceEvidence: SourceEvidenceAuthority;
  readonly changeAssurance: ChangeAssuranceAuthority;
  readonly taskWorktree: TaskWorktreeEvidenceAuthority;
  readonly physicalEvidence: PhysicalEvidenceAuthority;
  readonly originalTests: OriginalTestAuthority;
  readonly mutation: MutationEngineAuthority;
  readonly property: PropertyEngineAuthority;
  readonly coverageAuthority: CoverageAuthority;
  readonly exclusions: ExclusionAuthority;
  readonly reviewer: IndependentReviewer;
  readonly coverage: VerificationCoverageThresholds;
  readonly fuzz: DeterministicFuzzConfig;
  readonly limits: VerificationGateLimits;
}

export interface VerificationGateInput extends VerificationBindings {
  readonly version: 1;
  readonly evidence: Readonly<{
    readonly source: object;
    readonly changeAssurance: object;
    readonly taskWorktree: readonly object[];
    readonly physical: object;
    readonly originalTests: object;
  }>;
}

export type MutationKind = "operator" | "condition" | "boundary" | "return";

export type MutationOutcome = "killed" | "survived" | "timeout" | "invalid";

export type VerificationObjectiveFailureCode =
  | "ORIGINAL_TESTS_REJECTED"
  | "MUTATION_INVENTORY_REJECTED"
  | "MUTATION_SURVIVED"
  | "MUTATION_TIMEOUT"
  | "MUTATION_INVALID"
  | "PROPERTY_REJECTED"
  | "PROPERTY_COUNTEREXAMPLE"
  | "MODIFIED_NODE_UNCOVERED"
  | "MODIFIED_LINE_UNCOVERED"
  | "MODIFIED_BRANCH_UNCOVERED"
  | "COVERAGE_REJECTED";

export type VerificationGateFailureCode =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "SOURCE_EVIDENCE_REJECTED"
  | "CHANGE_ASSURANCE_REJECTED"
  | "TASK_WORKTREE_REJECTED"
  | "AUTHORITY_REJECTED"
  | "REVIEW_REJECTED"
  | "REPLAY_REJECTED"
  | VerificationObjectiveFailureCode;

export interface VerificationGateReceipt {
  readonly schema: "skizzles.verification-gate/receipt";
  readonly authorityId: string;
  readonly reviewerId: string;
  readonly taskId: string;
  readonly taskEpochDigest: VerificationDigest;
  readonly requestDigest: VerificationDigest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: VerificationDigest;
  readonly baselineDigest: VerificationDigest;
  readonly candidateDigest: VerificationDigest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly specLockDigest: VerificationDigest;
  readonly baselineManifestDigest: VerificationDigest;
  readonly candidateTestManifestDigest: VerificationDigest;
  readonly sourceEvidenceDigest: VerificationDigest;
  readonly compilerChainDigest: VerificationDigest;
  readonly complexityEvidenceDigest: VerificationDigest;
  readonly changeAssuranceDigest: VerificationDigest;
  readonly taskWorktreeEvidenceDigest: VerificationDigest;
  readonly worktreeViewDigest: VerificationDigest;
  readonly artifactReceiptDigest: VerificationDigest;
  readonly physicalEvidenceDigest: VerificationDigest;
  readonly originalTestReceiptDigest: VerificationDigest;
  readonly mutationInventoryDigest: VerificationDigest;
  readonly mutationEvidenceDigest: VerificationDigest;
  readonly propertyEvidenceDigest: VerificationDigest;
  readonly seedScheduleDigest: VerificationDigest;
  readonly requiredFuzzCaseCount: number;
  readonly requiredRandomFuzzCaseCount: number;
  readonly extremeVectorInventoryDigest: VerificationDigest;
  readonly requiredExtremeVectorCount: number;
  readonly coverageEvidenceDigest: VerificationDigest;
  readonly coverageObjectiveDigest: VerificationDigest;
  readonly coverageThresholdDigest: VerificationDigest;
  readonly reviewDigest: VerificationDigest;
  readonly modifiedNodeCount: number;
  readonly modifiedLineCount: number;
  readonly modifiedBranchCount: number;
  readonly mutantCount: number;
  readonly propertyCount: number;
  readonly receiptDigest: VerificationDigest;
}

export type VerificationGateResult =
  | Readonly<{ status: "accepted"; receipt: VerificationGateReceipt }>
  | Readonly<{
      status: "rejected";
      code: VerificationGateFailureCode;
      failures: readonly VerificationGateFailureCode[];
    }>;

export type VerificationGateVerifyResult =
  | Readonly<{
      status: "valid";
      receiptDigest: VerificationDigest;
      reviewDigest: VerificationDigest;
    }>
  | Readonly<{ status: "rejected"; code: "REPLAY_REJECTED" }>;

export interface VerificationGate {
  readonly evaluate: (input: unknown) => Promise<VerificationGateResult>;
  readonly verify: (input: unknown) => Promise<VerificationGateVerifyResult>;
}

export type VerificationGateCreationResult =
  | Readonly<{ status: "created"; verificationGate: VerificationGate }>
  | Readonly<{ status: "rejected"; code: "INVALID_CONFIG" }>;

export interface DeterministicFuzzCase {
  readonly seed: number;
  readonly caseIndex: number;
  readonly vector: readonly number[];
  readonly extreme: boolean;
}

export interface DeterministicFuzzAssertionResult {
  readonly status: "passed" | "failed";
  readonly scheduleDigest: VerificationDigest;
  readonly executedCases: number;
  readonly counterexample: DeterministicFuzzCase | null;
}
