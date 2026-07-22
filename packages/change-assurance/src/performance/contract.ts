import type {
  ChangeAssuranceExtension,
  ChangeAssuranceExtensionCreationResult,
  ChangeAssuranceExtensionInput,
  ChangeAssuranceExtensionResult,
} from "../contract.ts";
import type { Digest } from "../digest.ts";

export type BigOClass =
  | "O(1)"
  | "O(log n)"
  | "O(n)"
  | "O(n log n)"
  | "O(n^2)"
  | "O(n^3)"
  | "O(2^n)";

export interface BigOClaim {
  readonly notation: BigOClass;
  readonly inputMetric: string;
}

export interface PerformanceCandidateBinding {
  readonly path: string;
  readonly candidateDigest: Digest;
}

export interface PerformancePlan {
  readonly schemaVersion: 1;
  readonly claim: BigOClaim;
  readonly candidates: readonly PerformanceCandidateBinding[];
}

export type PerformancePlanCreationResult =
  | Readonly<{ readonly status: "created"; readonly plan: PerformancePlan }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: "INVALID_PERFORMANCE_PLAN";
    }>;

export interface PerformanceRegressionBaselinePoint {
  readonly inputSize: number;
  readonly maximumMedianMilliseconds: number;
}

export interface PerformanceRegressionBaseline {
  readonly baselineId: string;
  readonly points: readonly PerformanceRegressionBaselinePoint[];
  readonly maximumSlowdownRatio: number;
}

export interface PerformanceBenchmarkInvocation {
  readonly path: string;
  readonly candidateDigest: Digest;
  readonly candidateBytes: readonly number[];
  readonly inputSize: number;
  readonly sample: number;
}

export type PerformanceBenchmarkRunner = (
  invocation: PerformanceBenchmarkInvocation,
) => unknown | Promise<unknown>;

export interface PerformanceBenchmarkAuthorityConfig {
  readonly authorityId: string;
  readonly inputSizes: readonly number[];
  readonly samplesPerSize: number;
  readonly maximumCoefficientOfVariation: number;
  readonly maximumComplexityExponent: number;
  readonly regressionBaseline: PerformanceRegressionBaseline;
  readonly runCandidate: PerformanceBenchmarkRunner;
}

export interface PerformanceBenchmarkAuthority {
  readonly kind: "performance-benchmark-authority";
  readonly authorityId: string;
}

export type PerformanceBenchmarkAuthorityCreationResult =
  | Readonly<{
      readonly status: "created";
      readonly authority: PerformanceBenchmarkAuthority;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: "INVALID_PERFORMANCE_AUTHORITY_CONFIG";
    }>;

export interface PerformanceSampleReceipt {
  readonly inputSize: number;
  readonly durationsMilliseconds: readonly number[];
  readonly medianMilliseconds: number;
  readonly coefficientOfVariation: number;
}

export interface PerformanceCandidateReceipt
  extends PerformanceCandidateBinding {
  readonly samples: readonly PerformanceSampleReceipt[];
  readonly observedExponent: number;
  readonly observedClass: BigOClass;
  readonly maximumBaselineRatio: number;
}

export interface PerformanceAssuranceReceipt {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly planDigest: Digest;
  readonly claim: BigOClaim;
  readonly candidates: readonly PerformanceCandidateReceipt[];
  readonly baselineId: string;
  readonly receiptDigest: Digest;
}

export interface PerformanceAssessmentInput {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly plan: unknown;
  readonly candidates: readonly Readonly<{
    readonly path: string;
    readonly candidateBytes: readonly number[];
  }>[];
}

export type PerformanceFailureCode =
  | "INVALID_PERFORMANCE_INPUT"
  | "UNAUTHENTIC_PERFORMANCE_AUTHORITY"
  | "PERFORMANCE_PLAN_REJECTED"
  | "PERFORMANCE_TARGET_BINDING_REJECTED"
  | "BENCHMARK_AUTHORITY_REJECTED"
  | "BENCHMARK_FAILED"
  | "BIG_O_CLAIM_REJECTED"
  | "PERFORMANCE_VARIANCE_REJECTED"
  | "PERFORMANCE_REGRESSION_REJECTED";

export type PerformanceAssuranceResult =
  | Readonly<{
      readonly status: "accepted";
      readonly receipt: PerformanceAssuranceReceipt;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: PerformanceFailureCode;
    }>;

export type PerformanceExtensionAssessmentResult =
  Promise<ChangeAssuranceExtensionResult>;

export interface PerformanceAssuranceExtensionConfig {
  readonly id: string;
  readonly version: string;
  readonly authority: PerformanceBenchmarkAuthority;
}

export type PerformanceAssuranceExtensionCreationResult =
  ChangeAssuranceExtensionCreationResult;
export type PerformanceAssuranceExtension = ChangeAssuranceExtension;

export type PerformanceExtensionAssessor = (
  authority: unknown,
  input: ChangeAssuranceExtensionInput,
) => PerformanceExtensionAssessmentResult;
