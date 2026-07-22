import type {
  VerificationAuthorityKind,
  VerificationAuthorityRegistrationConfig,
  VerificationAuthorityRegistrationResult,
  VerificationAuthorityRequest,
} from "./contract.ts";
import { dataRecord, identifier } from "./object.ts";

type Evaluation = VerificationAuthorityRegistrationConfig["evaluate"];

const authorities = new WeakMap<object, Evaluation>();
function registerAuthority<K extends VerificationAuthorityKind>(
  input: unknown,
  kind: K,
): VerificationAuthorityRegistrationResult<K> {
  const record = dataRecord(input, ["id", "evaluate"]);
  if (
    record === undefined ||
    !identifier(record["id"]) ||
    typeof record["evaluate"] !== "function"
  ) {
    return { status: "rejected", code: "INVALID_AUTHORITY_CONFIG" };
  }
  const authority = Object.freeze({
    id: record["id"],
    kind,
  });
  authorities.set(authority, record["evaluate"] as Evaluation);
  return { status: "created", authority };
}

export function isVerificationAuthority(
  input: unknown,
): input is Readonly<{ id: string; kind: VerificationAuthorityKind }> {
  return typeof input === "object" && input !== null && authorities.has(input);
}

export async function invokeAuthority(
  authority: Readonly<{ id: string; kind: VerificationAuthorityKind }>,
  request: VerificationAuthorityRequest,
): Promise<unknown> {
  const evaluate = authorities.get(authority);
  if (evaluate === undefined) {
    throw new Error("unregistered authority");
  }
  return await evaluate(request);
}

export function authorityEvaluation(
  authority: Readonly<{ id: string; kind: VerificationAuthorityKind }>,
): Evaluation | undefined {
  return authorities.get(authority);
}

export function createSourceEvidenceAuthority(
  input: unknown,
): VerificationAuthorityRegistrationResult<"source-evidence"> {
  return registerAuthority(input, "source-evidence");
}

export function createChangeAssuranceAuthority(
  input: unknown,
): VerificationAuthorityRegistrationResult<"change-assurance"> {
  return registerAuthority(input, "change-assurance");
}

export function createTaskWorktreeEvidenceAuthority(
  input: unknown,
): VerificationAuthorityRegistrationResult<"task-worktree"> {
  return registerAuthority(input, "task-worktree");
}

export function createOriginalTestAuthority(
  input: unknown,
): VerificationAuthorityRegistrationResult<"original-tests"> {
  return registerAuthority(input, "original-tests");
}

export function createPhysicalEvidenceAuthority(
  input: unknown,
): VerificationAuthorityRegistrationResult<"physical-evidence"> {
  return registerAuthority(input, "physical-evidence");
}

export function createMutationEngineAuthority(
  input: unknown,
): VerificationAuthorityRegistrationResult<"mutation"> {
  return registerAuthority(input, "mutation");
}

export function createPropertyEngineAuthority(
  input: unknown,
): VerificationAuthorityRegistrationResult<"property"> {
  return registerAuthority(input, "property");
}

export function createCoverageAuthority(
  input: unknown,
): VerificationAuthorityRegistrationResult<"coverage"> {
  return registerAuthority(input, "coverage");
}

export function createExclusionAuthority(
  input: unknown,
): VerificationAuthorityRegistrationResult<"exclusion"> {
  return registerAuthority(input, "exclusion");
}

export function createIndependentReviewer(
  input: unknown,
): VerificationAuthorityRegistrationResult<"reviewer"> {
  return registerAuthority(input, "reviewer");
}
