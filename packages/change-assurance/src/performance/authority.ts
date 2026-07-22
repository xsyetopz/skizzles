import type {
  ChangeAssuranceExtension,
  ChangeAssuranceExtensionCreationResult,
  ChangeAssuranceExtensionInput,
  ChangeAssuranceExtensionResult,
} from "../contract.ts";
import { digestValue, isDigest } from "../digest.ts";
import {
  createChangeAssuranceExtension,
  isChangeAssuranceExtension,
} from "../extension.ts";
import {
  type PerformanceAuthorityState,
  stateFromConfig,
} from "./authority-state.ts";
import type {
  PerformanceAssessmentInput,
  PerformanceAssuranceReceipt,
  PerformanceAssuranceResult,
  PerformanceBenchmarkAuthority,
  PerformanceBenchmarkAuthorityCreationResult,
} from "./contract.ts";
import {
  digestPlan,
  parsePerformanceAssessment,
  parsePerformanceAuthorityConfig,
  parsePerformancePlan,
} from "./input.ts";
import { assessParsedPerformance } from "./measure.ts";

const authorities = new WeakMap<object, PerformanceAuthorityState>();
const acceptedBenchmarks = new WeakMap<
  object,
  Map<string, PerformanceAssuranceReceipt>
>();
const receipts = new WeakSet<object>();

export function createPerformanceBenchmarkAuthority(
  input: unknown,
): PerformanceBenchmarkAuthorityCreationResult {
  const parsed = parsePerformanceAuthorityConfig(input);
  if (parsed === undefined) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_PERFORMANCE_AUTHORITY_CONFIG",
    });
  }
  const authority: PerformanceBenchmarkAuthority = Object.freeze({
    kind: "performance-benchmark-authority",
    authorityId: parsed.authorityId,
  });
  authorities.set(authority, stateFromConfig(parsed));
  acceptedBenchmarks.set(authority, new Map());
  return Object.freeze({ status: "created", authority });
}

export function isPerformanceBenchmarkAuthority(
  input: unknown,
): input is PerformanceBenchmarkAuthority {
  return typeof input === "object" && input !== null && authorities.has(input);
}

export function createPerformanceAssuranceExtension(
  input: unknown,
): ChangeAssuranceExtensionCreationResult {
  if (
    !(
      exactExtensionInput(input) &&
      isPerformanceBenchmarkAuthority(input.authority)
    )
  ) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_EXTENSION_CONFIG",
    });
  }
  return createChangeAssuranceExtension({
    domain: "performance",
    id: input.id,
    version: input.version,
    assess: (extensionInput: ChangeAssuranceExtensionInput) =>
      assessPerformanceExtension(input.authority, extensionInput),
  });
}

export function isPerformanceAssuranceExtension(
  input: unknown,
): input is ChangeAssuranceExtension {
  return isChangeAssuranceExtension(input) && input.domain === "performance";
}

export async function assessPerformance(
  authority: unknown,
  input: unknown,
): Promise<PerformanceAssuranceResult> {
  if (!isPerformanceBenchmarkAuthority(authority)) {
    return Object.freeze({
      status: "rejected",
      code: "UNAUTHENTIC_PERFORMANCE_AUTHORITY",
    });
  }
  const state = authorities.get(authority);
  if (state === undefined) {
    return Object.freeze({
      status: "rejected",
      code: "UNAUTHENTIC_PERFORMANCE_AUTHORITY",
    });
  }
  const parsed = parsePerformanceAssessment(input);
  if (parsed === undefined) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_PERFORMANCE_INPUT",
    });
  }
  if (parsed === "target-stale") {
    return Object.freeze({
      status: "rejected",
      code: "PERFORMANCE_TARGET_BINDING_REJECTED",
    });
  }
  try {
    const cache = acceptedBenchmarks.get(authority);
    if (cache === undefined)
      return Object.freeze({
        status: "rejected",
        code: "BENCHMARK_AUTHORITY_REJECTED",
      });
    const cacheKey = digestValue({
      requestDigest: parsed.requestDigest,
      repositoryId: parsed.repositoryId,
      planDigest: parsed.planDigest,
      candidates: parsed.candidates.map(({ path, candidateDigest }) => ({
        path,
        candidateDigest,
      })),
    });
    const cached = cache.get(cacheKey);
    if (cached !== undefined)
      return Object.freeze({ status: "accepted", receipt: cached });
    const result = await assessParsedPerformance(state, parsed);
    if (result.status === "accepted") {
      cache.set(cacheKey, result.receipt);
      receipts.add(result.receipt);
    }
    return result;
  } catch {
    return Object.freeze({
      status: "rejected",
      code: "BENCHMARK_AUTHORITY_REJECTED",
    });
  }
}

export async function assessPerformanceExtension(
  authority: unknown,
  input: ChangeAssuranceExtensionInput,
): Promise<ChangeAssuranceExtensionResult> {
  if (input.domain !== "performance") {
    return Object.freeze({
      status: "rejected",
      code: "PERFORMANCE_DOMAIN_MISMATCH",
    });
  }
  const plan = parsePerformancePlan(input.plan);
  if (plan === undefined) {
    return Object.freeze({
      status: "rejected",
      code: "PERFORMANCE_PLAN_REJECTED",
    });
  }
  const candidates: Array<
    Readonly<{ path: string; candidateBytes: readonly number[] }>
  > = [];
  for (const target of input.targets) {
    if (target.candidateBytes === null) continue;
    candidates.push(
      Object.freeze({
        path: target.path,
        candidateBytes: target.candidateBytes,
      }),
    );
  }
  const assessmentInput: PerformanceAssessmentInput = Object.freeze({
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    plan,
    candidates: Object.freeze(candidates),
  });
  const result = await assessPerformance(authority, assessmentInput);
  if (result.status !== "accepted") {
    return Object.freeze({ status: "rejected", code: result.code });
  }
  const evidenceDigest = digestValue({
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    treeDigest: input.treeDigest,
    baselineDigest: input.baselineDigest,
    declarationDigest: input.declarationDigest,
    planDigest: digestPlan(plan),
    receiptDigest: result.receipt.receiptDigest,
  });
  if (!isDigest(evidenceDigest)) {
    return Object.freeze({
      status: "rejected",
      code: "PERFORMANCE_RECEIPT_INVALID",
    });
  }
  return Object.freeze({ status: "accepted", evidenceDigest });
}

export function isPerformanceReceipt(
  input: unknown,
): input is PerformanceAssuranceReceipt {
  return typeof input === "object" && input !== null && receipts.has(input);
}

function exactExtensionInput(value: unknown): value is Readonly<{
  readonly id: string;
  readonly version: string;
  readonly authority: unknown;
}> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  )
    return false;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== 3 ||
    !["id", "version", "authority"].every((key) => own.includes(key))
  )
    return false;
  const id = Reflect.get(value, "id");
  const version = Reflect.get(value, "version");
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    typeof version === "string" &&
    version.length > 0 &&
    version.length <= 64
  );
}
