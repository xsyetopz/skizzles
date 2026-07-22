import { types } from "node:util";
import type {
  ChangeAssurance,
  ChangeAssuranceAssessmentInput,
  ChangeAssuranceReceipt,
  ChangeAssuranceTarget,
} from "../../contract.ts";
import { digestBytes, digestValue } from "../../digest.ts";
import type { SecurityDigest } from "../contract.ts";
import type { SecurityPolicyLintInput } from "./contract.ts";

const authorityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export function authorityId(value: unknown): string | undefined {
  return typeof value === "string" && authorityPattern.test(value)
    ? value
    : undefined;
}

export function exactFrozenRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    !Object.isFrozen(value)
  )
    return;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
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

export function parseLintInput(
  value: unknown,
): SecurityPolicyLintInput | undefined {
  const record = exactFrozenRecord(value, ["assessment", "assuranceReceipt"]);
  const assessment = record?.get("assessment");
  const assuranceReceipt = record?.get("assuranceReceipt");
  if (
    record === undefined ||
    typeof assessment !== "object" ||
    assessment === null ||
    typeof assuranceReceipt !== "object" ||
    assuranceReceipt === null
  )
    return;
  return Object.freeze({
    assessment: assessment as ChangeAssuranceAssessmentInput,
    assuranceReceipt: assuranceReceipt as ChangeAssuranceReceipt,
  });
}

export function assuranceBinds(
  assurance: ChangeAssurance,
  input: SecurityPolicyLintInput,
): boolean {
  try {
    return assurance.verify(
      Object.freeze({
        receipt: input.assuranceReceipt,
        assessment: input.assessment,
      }),
    );
  } catch {
    return false;
  }
}

export function assessmentDigest(
  assessment: ChangeAssuranceAssessmentInput,
): SecurityDigest {
  return digestValue({
    requestDigest: assessment.requestDigest,
    repositoryId: assessment.repositoryId,
    treeDigest: assessment.treeDigest,
    baselineDigest: assessment.baselineDigest,
    declarationDigest: assessment.declaration.declarationDigest,
    targets: assessment.targets.map(targetMaterial),
  });
}

export function targetMaterial(target: ChangeAssuranceTarget): Readonly<{
  path: string;
  operation: ChangeAssuranceTarget["operation"];
  baselineDigest: SecurityDigest | null;
  candidateDigest: SecurityDigest | null;
}> {
  return Object.freeze({
    path: target.path,
    operation: target.operation,
    baselineDigest:
      target.baselineBytes === null
        ? null
        : digestBytes(Uint8Array.from(target.baselineBytes)),
    candidateDigest:
      target.candidateBytes === null
        ? null
        : digestBytes(Uint8Array.from(target.candidateBytes)),
  });
}

export function candidateDigestFor(
  assessment: ChangeAssuranceAssessmentInput,
  path: string,
): SecurityDigest | undefined {
  const target = assessment.targets.find(
    (candidate) => candidate.path === path,
  );
  return target?.candidateBytes === null || target?.candidateBytes === undefined
    ? undefined
    : digestBytes(Uint8Array.from(target.candidateBytes));
}
