import type { Digest } from "../digest.ts";
import {
  digestBytes as digestRawBytes,
  digestValue,
  isDigest,
} from "../digest.ts";
import { normalizeTargetPath } from "../path.ts";
import type {
  BigOClaim,
  BigOClass,
  PerformanceBenchmarkAuthorityConfig,
  PerformanceCandidateBinding,
  PerformancePlan,
  PerformancePlanCreationResult,
  PerformanceRegressionBaseline,
} from "./contract.ts";

const bigOClasses = Object.freeze([
  "O(1)",
  "O(log n)",
  "O(n)",
  "O(n log n)",
  "O(n^2)",
  "O(n^3)",
  "O(2^n)",
] satisfies readonly BigOClass[]);
const maximumAuthorityIdLength = 128;
const maximumInputSizes = 16;
const maximumSamplesPerSize = 12;
const maximumCandidateBytes = 8 * 1024 * 1024;
const maximumCandidates = 256;
const maximumMetricLength = 128;

export interface ParsedPerformanceAuthorityConfig {
  readonly authorityId: string;
  readonly inputSizes: readonly number[];
  readonly samplesPerSize: number;
  readonly maximumCoefficientOfVariation: number;
  readonly maximumComplexityExponent: number;
  readonly regressionBaseline: PerformanceRegressionBaseline;
  readonly runCandidate: PerformanceBenchmarkAuthorityConfig["runCandidate"];
}

export interface ParsedPerformanceAssessment {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly plan: PerformancePlan;
  readonly planDigest: Digest;
  readonly candidates: readonly Readonly<{
    readonly path: string;
    readonly candidateDigest: Digest;
    readonly candidateBytes: readonly number[];
  }>[];
}

export function parsePerformanceAuthorityConfig(
  value: unknown,
): ParsedPerformanceAuthorityConfig | undefined {
  const record = exactRecord(value, [
    "authorityId",
    "inputSizes",
    "samplesPerSize",
    "maximumCoefficientOfVariation",
    "maximumComplexityExponent",
    "regressionBaseline",
    "runCandidate",
  ]);
  if (!record) return;
  const authorityId = record.get("authorityId");
  const inputSizes = parseInputSizes(record.get("inputSizes"));
  const maximumCoefficientOfVariation = record.get(
    "maximumCoefficientOfVariation",
  );
  const maximumComplexityExponent = record.get("maximumComplexityExponent");
  const regressionBaseline = parseBaseline(
    record.get("regressionBaseline"),
    inputSizes,
  );
  const samplesPerSizeValue = record.get("samplesPerSize");
  const runCandidate = record.get("runCandidate");
  if (
    typeof authorityId !== "string" ||
    authorityId.length === 0 ||
    authorityId.length > maximumAuthorityIdLength ||
    inputSizes === undefined ||
    !integerBetween(samplesPerSizeValue, 1, maximumSamplesPerSize) ||
    !finiteBetween(maximumCoefficientOfVariation, 0, 10) ||
    !finiteBetween(maximumComplexityExponent, 0, 8) ||
    regressionBaseline === undefined ||
    !isRunner(runCandidate)
  )
    return;
  return Object.freeze({
    authorityId,
    inputSizes,
    samplesPerSize: samplesPerSizeValue,
    maximumCoefficientOfVariation,
    maximumComplexityExponent,
    regressionBaseline,
    runCandidate,
  });
}

export function parsePerformanceAssessment(
  value: unknown,
): ParsedPerformanceAssessment | "target-stale" | undefined {
  const record = exactRecord(value, [
    "requestDigest",
    "repositoryId",
    "plan",
    "candidates",
  ]);
  if (!record) return;
  const requestDigest = record.get("requestDigest");
  const repositoryId = record.get("repositoryId");
  if (
    !isDigest(requestDigest) ||
    typeof repositoryId !== "string" ||
    repositoryId.length === 0 ||
    repositoryId.length > 256
  )
    return;
  const plan = parsePerformancePlan(record.get("plan"));
  const candidates = parseCandidates(record.get("candidates"));
  if (plan === undefined || candidates === undefined) return;
  if (plan.candidates.length !== candidates.length) return "target-stale";
  for (let index = 0; index < plan.candidates.length; index += 1) {
    const expected = plan.candidates[index];
    const candidate = candidates[index];
    if (
      expected === undefined ||
      candidate === undefined ||
      expected.path !== candidate.path ||
      expected.candidateDigest !== candidate.candidateDigest
    )
      return "target-stale";
  }
  return Object.freeze({
    requestDigest,
    repositoryId,
    plan,
    planDigest: digestPlan(plan),
    candidates,
  });
}

export function parsePerformancePlan(
  value: unknown,
): PerformancePlan | undefined {
  const record = exactRecord(value, ["schemaVersion", "claim", "candidates"]);
  if (!record || record.get("schemaVersion") !== 1) return;
  const claim = parseClaim(record.get("claim"));
  const candidates = parseBindings(record.get("candidates"));
  if (claim === undefined || candidates === undefined) return;
  return Object.freeze({ schemaVersion: 1, claim, candidates });
}

export function createPerformancePlan(
  value: unknown,
): PerformancePlanCreationResult {
  const plan = parsePerformancePlan(value);
  return plan === undefined
    ? Object.freeze({ status: "rejected", code: "INVALID_PERFORMANCE_PLAN" })
    : Object.freeze({ status: "created", plan });
}

export function digestPlan(plan: PerformancePlan): Digest {
  return digestValue({
    schemaVersion: plan.schemaVersion,
    claim: plan.claim,
    candidates: plan.candidates,
  });
}

export function parseCandidateBytes(
  value: unknown,
): readonly number[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length > maximumCandidateBytes
  )
    return;
  const bytes: number[] = [];
  for (const byte of value) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return;
    bytes.push(byte);
  }
  return Object.freeze(bytes);
}

function parseInputSizes(value: unknown): readonly number[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length < 3 ||
    value.length > maximumInputSizes
  )
    return;
  const sizes: number[] = [];
  let previous = 0;
  for (const valueAtSize of value) {
    if (
      !Number.isSafeInteger(valueAtSize) ||
      valueAtSize < 1 ||
      valueAtSize <= previous
    )
      return;
    previous = valueAtSize;
    sizes.push(valueAtSize);
  }
  return Object.freeze(sizes);
}

function parseBaseline(
  value: unknown,
  inputSizes: readonly number[] | undefined,
): PerformanceRegressionBaseline | undefined {
  const record = exactRecord(value, [
    "baselineId",
    "points",
    "maximumSlowdownRatio",
  ]);
  if (!record || inputSizes === undefined) return;
  const baselineId = record.get("baselineId");
  const points = record.get("points");
  const maximumSlowdownRatio = record.get("maximumSlowdownRatio");
  if (
    typeof baselineId !== "string" ||
    baselineId.length === 0 ||
    baselineId.length > maximumAuthorityIdLength ||
    !Array.isArray(points) ||
    !Object.isFrozen(points) ||
    points.length !== inputSizes.length ||
    !finiteBetween(maximumSlowdownRatio, 1, 100)
  )
    return;
  const parsed: { inputSize: number; maximumMedianMilliseconds: number }[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const pointRecord = exactRecord(point, [
      "inputSize",
      "maximumMedianMilliseconds",
    ]);
    if (!pointRecord) return;
    const inputSize = pointRecord.get("inputSize");
    const maximumMedianMilliseconds = pointRecord.get(
      "maximumMedianMilliseconds",
    );
    if (
      typeof inputSize !== "number" ||
      inputSize !== inputSizes[index] ||
      !finiteBetween(maximumMedianMilliseconds, 0.000_001, 86_400_000)
    )
      return;
    parsed.push(Object.freeze({ inputSize, maximumMedianMilliseconds }));
  }
  return Object.freeze({
    baselineId,
    points: Object.freeze(parsed),
    maximumSlowdownRatio,
  });
}

function parseClaim(value: unknown): BigOClaim | undefined {
  const record = exactRecord(value, ["notation", "inputMetric"]);
  if (!record) return;
  const notation = record.get("notation");
  const inputMetric = record.get("inputMetric");
  if (
    !isBigOClass(notation) ||
    typeof inputMetric !== "string" ||
    inputMetric.length === 0 ||
    inputMetric.length > maximumMetricLength ||
    !/^[A-Za-z][A-Za-z0-9 _-]*$/u.test(inputMetric)
  )
    return;
  return Object.freeze({ notation, inputMetric });
}

function parseBindings(
  value: unknown,
): readonly PerformanceCandidateBinding[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length === 0 ||
    value.length > maximumCandidates
  )
    return;
  const bindings: PerformanceCandidateBinding[] = [];
  let previousPath = "";
  for (const raw of value) {
    const record = exactRecord(raw, ["path", "candidateDigest"]);
    if (!record) return;
    const path = normalizeTargetPath(record.get("path"));
    const candidateDigest = record.get("candidateDigest");
    if (
      path === undefined ||
      !isDigest(candidateDigest) ||
      path <= previousPath
    )
      return;
    previousPath = path;
    bindings.push(Object.freeze({ path, candidateDigest }));
  }
  return Object.freeze(bindings);
}

function parseCandidates(
  value: unknown,
): ParsedPerformanceAssessment["candidates"] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length === 0 ||
    value.length > maximumCandidates
  )
    return;
  const candidates: ParsedPerformanceAssessment["candidates"][number][] = [];
  let previousPath = "";
  for (const raw of value) {
    const record = exactRecord(raw, ["path", "candidateBytes"]);
    if (!record) return;
    const path = normalizeTargetPath(record.get("path"));
    const candidateBytes = parseCandidateBytes(record.get("candidateBytes"));
    if (
      path === undefined ||
      path <= previousPath ||
      candidateBytes === undefined
    )
      return;
    previousPath = path;
    const candidateDigest = digestRawBytes(Uint8Array.from(candidateBytes));
    candidates.push(Object.freeze({ path, candidateDigest, candidateBytes }));
  }
  return Object.freeze(candidates);
}

function finiteBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function integerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isInteger(value) &&
    typeof value === "number" &&
    value >= minimum &&
    value <= maximum
  );
}

function isRunner(
  value: unknown,
): value is PerformanceBenchmarkAuthorityConfig["runCandidate"] {
  return typeof value === "function";
}

function isBigOClass(value: unknown): value is BigOClass {
  if (typeof value !== "string") return false;
  return bigOClasses.some((candidate) => candidate === value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  )
    return;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    return;
  const result = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    result.set(key, descriptor.value);
  }
  return result;
}
