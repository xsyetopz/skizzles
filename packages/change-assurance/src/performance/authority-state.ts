import type {
  PerformanceBenchmarkAuthorityConfig,
  PerformanceBenchmarkRunner,
  PerformanceRegressionBaseline,
} from "./contract.ts";

export interface PerformanceAuthorityState {
  readonly authorityId: string;
  readonly inputSizes: readonly number[];
  readonly samplesPerSize: number;
  readonly maximumCoefficientOfVariation: number;
  readonly maximumComplexityExponent: number;
  readonly regressionBaseline: PerformanceRegressionBaseline;
  readonly runCandidate: PerformanceBenchmarkRunner;
}

export function stateFromConfig(
  config: PerformanceBenchmarkAuthorityConfig,
): PerformanceAuthorityState {
  return Object.freeze({
    authorityId: config.authorityId,
    inputSizes: Object.freeze([...config.inputSizes]),
    samplesPerSize: config.samplesPerSize,
    maximumCoefficientOfVariation: config.maximumCoefficientOfVariation,
    maximumComplexityExponent: config.maximumComplexityExponent,
    regressionBaseline: Object.freeze({
      baselineId: config.regressionBaseline.baselineId,
      points: Object.freeze(
        config.regressionBaseline.points.map((point) =>
          Object.freeze({ ...point }),
        ),
      ),
      maximumSlowdownRatio: config.regressionBaseline.maximumSlowdownRatio,
    }),
    runCandidate: config.runCandidate,
  });
}
