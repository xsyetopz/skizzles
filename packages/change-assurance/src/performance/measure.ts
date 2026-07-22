import { digestValue } from "../digest.ts";
import type { PerformanceAuthorityState } from "./authority-state.ts";
import type {
  BigOClass,
  PerformanceAssuranceReceipt,
  PerformanceCandidateReceipt,
  PerformanceSampleReceipt,
} from "./contract.ts";
import type { ParsedPerformanceAssessment } from "./input.ts";

const minimumMeasurementMilliseconds = 0.001;
const maximumAllowedClaimSlack = 0.35;
const complexityExponent: Readonly<Record<BigOClass, number>> = Object.freeze({
  "O(1)": 0,
  "O(log n)": 0.25,
  "O(n)": 1,
  "O(n log n)": 1.5,
  "O(n^2)": 2,
  "O(n^3)": 3,
  "O(2^n)": 8,
});

export async function assessParsedPerformance(
  state: PerformanceAuthorityState,
  input: ParsedPerformanceAssessment,
): Promise<
  | Readonly<{
      readonly status: "accepted";
      readonly receipt: PerformanceAssuranceReceipt;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code:
        | "PERFORMANCE_TARGET_BINDING_REJECTED"
        | "BENCHMARK_FAILED"
        | "BIG_O_CLAIM_REJECTED"
        | "PERFORMANCE_VARIANCE_REJECTED"
        | "PERFORMANCE_REGRESSION_REJECTED";
    }>
> {
  const candidates: PerformanceCandidateReceipt[] = [];
  for (const candidate of input.candidates) {
    const measured = await measureCandidate(
      state,
      input.plan.claim.notation,
      candidate,
    );
    if (measured.status !== "accepted") {
      return measured;
    }
    candidates.push(measured.receipt);
  }
  const material = {
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    planDigest: input.planDigest,
    claim: input.plan.claim,
    candidates,
    baselineId: state.regressionBaseline.baselineId,
  };
  return Object.freeze({
    status: "accepted",
    receipt: Object.freeze({
      ...material,
      candidates: Object.freeze(candidates),
      receiptDigest: digestValue(material),
    }),
  });
}

async function measureCandidate(
  state: PerformanceAuthorityState,
  claim: BigOClass,
  candidate: ParsedPerformanceAssessment["candidates"][number],
): Promise<
  | Readonly<{
      readonly status: "accepted";
      readonly receipt: PerformanceCandidateReceipt;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code:
        | "BENCHMARK_FAILED"
        | "BIG_O_CLAIM_REJECTED"
        | "PERFORMANCE_VARIANCE_REJECTED"
        | "PERFORMANCE_REGRESSION_REJECTED";
    }>
> {
  const samples: PerformanceSampleReceipt[] = [];
  for (let sizeIndex = 0; sizeIndex < state.inputSizes.length; sizeIndex += 1) {
    const inputSize = state.inputSizes[sizeIndex];
    if (inputSize === undefined) {
      return Object.freeze({ status: "rejected", code: "BENCHMARK_FAILED" });
    }
    const durations: number[] = [];
    for (let sample = 0; sample < state.samplesPerSize; sample += 1) {
      const started = globalThis.performance.now();
      try {
        await state.runCandidate(
          Object.freeze({
            path: candidate.path,
            candidateDigest: candidate.candidateDigest,
            candidateBytes: candidate.candidateBytes,
            inputSize,
            sample,
          }),
        );
      } catch {
        return Object.freeze({ status: "rejected", code: "BENCHMARK_FAILED" });
      }
      const elapsed = globalThis.performance.now() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0) {
        return Object.freeze({ status: "rejected", code: "BENCHMARK_FAILED" });
      }
      durations.push(Math.max(elapsed, minimumMeasurementMilliseconds));
    }
    const medianMilliseconds = median(durations);
    const coefficientOfVariation = variation(durations, medianMilliseconds);
    if (coefficientOfVariation > state.maximumCoefficientOfVariation) {
      return Object.freeze({
        status: "rejected",
        code: "PERFORMANCE_VARIANCE_REJECTED",
      });
    }
    const baseline = state.regressionBaseline.points[sizeIndex];
    if (
      baseline === undefined ||
      medianMilliseconds >
        baseline.maximumMedianMilliseconds *
          state.regressionBaseline.maximumSlowdownRatio
    ) {
      return Object.freeze({
        status: "rejected",
        code: "PERFORMANCE_REGRESSION_REJECTED",
      });
    }
    samples.push(
      Object.freeze({
        inputSize,
        durationsMilliseconds: Object.freeze(durations),
        medianMilliseconds,
        coefficientOfVariation,
      }),
    );
  }
  const observedExponent = scalingExponent(samples);
  const claimedExponent = complexityExponent[claim];
  if (
    claimedExponent === undefined ||
    observedExponent > claimedExponent + maximumAllowedClaimSlack ||
    observedExponent > state.maximumComplexityExponent
  ) {
    return Object.freeze({ status: "rejected", code: "BIG_O_CLAIM_REJECTED" });
  }
  const maximumBaselineRatio = Math.max(
    ...samples.map((sample, index) => {
      const baseline = state.regressionBaseline.points[index];
      return baseline === undefined
        ? Number.POSITIVE_INFINITY
        : sample.medianMilliseconds / baseline.maximumMedianMilliseconds;
    }),
  );
  return Object.freeze({
    status: "accepted",
    receipt: Object.freeze({
      path: candidate.path,
      candidateDigest: candidate.candidateDigest,
      samples: Object.freeze(samples),
      observedExponent,
      observedClass: observedClass(observedExponent),
      maximumBaselineRatio,
    }),
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - (sorted.length % 2 === 0 ? 1 : 0)];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return (lower + upper) / 2;
}

function variation(values: readonly number[], center: number): number {
  if (center <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const variance =
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
    values.length;
  return Math.sqrt(variance) / center;
}

function scalingExponent(samples: readonly PerformanceSampleReceipt[]): number {
  if (samples.length < 2) {
    return Number.POSITIVE_INFINITY;
  }
  const points = samples.map((sample) => ({
    x: Math.log(sample.inputSize),
    y: Math.log(
      Math.max(sample.medianMilliseconds, minimumMeasurementMilliseconds),
    ),
  }));
  const xMean = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce(
    (sum, point) => sum + (point.x - xMean) * (point.y - yMean),
    0,
  );
  const denominator = points.reduce(
    (sum, point) => sum + (point.x - xMean) ** 2,
    0,
  );
  return denominator <= 0
    ? Number.POSITIVE_INFINITY
    : Math.max(0, numerator / denominator);
}

function observedClass(exponent: number) {
  if (exponent <= 0.25) {
    return "O(log n)";
  }
  if (exponent <= 1) {
    return "O(n)";
  }
  if (exponent <= 1.5) {
    return "O(n log n)";
  }
  if (exponent <= 2) {
    return "O(n^2)";
  }
  if (exponent <= 3) {
    return "O(n^3)";
  }
  return "O(2^n)";
}
