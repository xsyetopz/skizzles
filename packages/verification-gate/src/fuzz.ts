import type {
  DeterministicFuzzAssertionResult,
  DeterministicFuzzCase,
  DeterministicFuzzConfig,
} from "./contract.ts";
import type { VerificationDigest } from "./digest.ts";
import { digestValue } from "./digest.ts";

const maximumSeeds = 64;
const maximumCases = 4_096;
const maximumDimensions = 32;

export function createDeterministicSeedSchedule(
  rootSeed: number,
  count: number,
): readonly number[] {
  if (
    !Number.isSafeInteger(rootSeed) ||
    rootSeed < 0 ||
    rootSeed > 0xffff_ffff ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > maximumSeeds
  )
    throw new TypeError("invalid deterministic seed schedule");
  const seeds: number[] = [];
  let state = rootSeed >>> 0;
  for (let index = 0; index < count; index += 1) {
    state = mix32((state + 0x9e37_79b9 + index) >>> 0);
    seeds.push(state);
  }
  return Object.freeze(seeds);
}

export async function assertDeterministicFuzz(
  config: DeterministicFuzzConfig,
  assertion: (testCase: DeterministicFuzzCase) => boolean | Promise<boolean>,
): Promise<DeterministicFuzzAssertionResult> {
  validateConfig(config);
  const schedule = createDeterministicSeedSchedule(
    config.rootSeed,
    config.seeds,
  );
  const cases = fuzzCases(config, schedule);
  const scheduleDigest = digestValue({
    schedule,
    casesPerSeed: config.casesPerSeed,
    dimensions: config.dimensions,
    minimum: config.minimum,
    maximum: config.maximum,
    extremes: config.extremes,
  });
  let executedCases = 0;
  for (const testCase of cases) {
    executedCases += 1;
    if (!(await assertion(testCase))) {
      return Object.freeze({
        status: "failed" as const,
        scheduleDigest,
        executedCases,
        counterexample: testCase,
      });
    }
  }
  return Object.freeze({
    status: "passed" as const,
    scheduleDigest,
    executedCases,
    counterexample: null,
  });
}

export function deterministicFuzzCaseCount(
  config: DeterministicFuzzConfig,
): number {
  validateConfig(config);
  return (
    extremeVectors(config).length + deterministicFuzzRandomCaseCount(config)
  );
}

export function deterministicFuzzRandomCaseCount(
  config: DeterministicFuzzConfig,
): number {
  validateConfig(config);
  return config.seeds * config.casesPerSeed;
}

export function deterministicExtremeVectorDigests(
  config: DeterministicFuzzConfig,
): readonly VerificationDigest[] {
  validateConfig(config);
  return Object.freeze(
    extremeVectors(config).map((vector, ordinal) =>
      digestValue(Object.freeze({ ordinal, vector })),
    ),
  );
}

export function fuzzScheduleDigest(
  config: DeterministicFuzzConfig,
): ReturnType<typeof digestValue> {
  validateConfig(config);
  return digestValue({
    schedule: createDeterministicSeedSchedule(config.rootSeed, config.seeds),
    casesPerSeed: config.casesPerSeed,
    dimensions: config.dimensions,
    minimum: config.minimum,
    maximum: config.maximum,
    extremes: config.extremes,
  });
}

function fuzzCases(
  config: DeterministicFuzzConfig,
  schedule: readonly number[],
): readonly DeterministicFuzzCase[] {
  const result: DeterministicFuzzCase[] = [];
  let index = 0;
  for (const vector of extremeVectors(config)) {
    result.push(
      Object.freeze({
        seed: schedule[0] as number,
        caseIndex: index,
        vector,
        extreme: true,
      }),
    );
    index += 1;
  }
  for (const seed of schedule) {
    let state = seed;
    for (let caseIndex = 0; caseIndex < config.casesPerSeed; caseIndex += 1) {
      const vector: number[] = [];
      for (let dimension = 0; dimension < config.dimensions; dimension += 1) {
        state = mix32((state + dimension + caseIndex) >>> 0);
        const unit = state / 0xffff_ffff;
        vector.push(config.minimum + unit * (config.maximum - config.minimum));
      }
      result.push(
        Object.freeze({
          seed,
          caseIndex,
          vector: Object.freeze(vector),
          extreme: false,
        }),
      );
    }
  }
  return Object.freeze(result);
}

function extremeVectors(
  config: DeterministicFuzzConfig,
): readonly (readonly number[])[] {
  const values = new Set<number>([
    config.minimum,
    config.maximum,
    Math.min(config.maximum, Math.max(config.minimum, 0)),
    ...config.extremes,
  ]);
  const result: Array<readonly number[]> = [];
  for (const value of values) {
    result.push(
      Object.freeze(Array.from({ length: config.dimensions }, () => value)),
    );
  }
  result.push(
    Object.freeze(
      Array.from({ length: config.dimensions }, (_, index) =>
        index % 2 === 0 ? config.minimum : config.maximum,
      ),
    ),
  );
  return Object.freeze(result);
}

function validateConfig(config: DeterministicFuzzConfig): void {
  if (
    !Number.isSafeInteger(config.rootSeed) ||
    config.rootSeed < 0 ||
    config.rootSeed > 0xffff_ffff ||
    !Number.isSafeInteger(config.seeds) ||
    config.seeds < 1 ||
    config.seeds > maximumSeeds ||
    !Number.isSafeInteger(config.casesPerSeed) ||
    config.casesPerSeed < 1 ||
    config.casesPerSeed > maximumCases ||
    !Number.isSafeInteger(config.dimensions) ||
    config.dimensions < 1 ||
    config.dimensions > maximumDimensions ||
    !Number.isFinite(config.minimum) ||
    !Number.isFinite(config.maximum) ||
    config.minimum >= config.maximum ||
    !Array.isArray(config.extremes) ||
    !Object.isFrozen(config.extremes) ||
    config.extremes.length > 16 ||
    config.extremes.some(
      (value) =>
        !Number.isFinite(value) ||
        value < config.minimum ||
        value > config.maximum,
    )
  )
    throw new TypeError("invalid deterministic fuzz configuration");
}

function mix32(value: number): number {
  let state = value >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x21f0_aaad);
  state = Math.imul(state ^ (state >>> 15), 0x735a_2d97);
  return (state ^ (state >>> 15)) >>> 0;
}
