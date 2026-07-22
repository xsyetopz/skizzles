import {
  type ChangeAssurance,
  type ChangeAssuranceReceipt,
  type ChangeDeclaration,
  isChangeAssuranceReceipt,
} from "@skizzles/change-assurance";
import type { Digest } from "../../digest.ts";
import type { PreparedBatch } from "../source/evidence.ts";

export interface AssuranceEvidence {
  readonly receipt: ChangeAssuranceReceipt;
  readonly input: Readonly<{
    requestDigest: Digest;
    repositoryId: string;
    treeDigest: Digest;
    baselineDigest: Digest;
    declaration: ChangeDeclaration;
    targets: readonly Readonly<{
      path: string;
      operation: "write";
      baselineBytes: readonly number[];
      candidateBytes: readonly number[];
    }>[];
  }>;
}

export async function assessChange(
  assurance: ChangeAssurance,
  input: Readonly<{
    requestDigest: Digest;
    repositoryId: string;
    treeDigest: Digest;
    baselineDigest: Digest;
    declaration: ChangeDeclaration;
  }>,
  prepared: PreparedBatch,
): Promise<AssuranceEvidence | undefined> {
  const targets = Object.freeze(
    prepared.artifacts.map((artifact, index) => {
      const baselineBytes = prepared.baselineBytes[index];
      const candidateBytes = prepared.candidateBytes[index];
      if (baselineBytes === undefined || candidateBytes === undefined) {
        throw new Error("prepared source target bytes missing");
      }
      return Object.freeze({
        path: artifact.path,
        operation: "write" as const,
        baselineBytes,
        candidateBytes,
      });
    }),
  );
  const assessmentInput = Object.freeze({ ...input, targets });
  let result: Awaited<ReturnType<ChangeAssurance["assess"]>>;
  try {
    result = await assurance.assess(assessmentInput);
  } catch {
    return;
  }
  if (
    result.status !== "accepted" ||
    !isChangeAssuranceReceipt(result.receipt) ||
    result.receipt.requestDigest !== input.requestDigest ||
    result.receipt.repositoryId !== input.repositoryId ||
    result.receipt.treeDigest !== input.treeDigest ||
    result.receipt.baselineDigest !== input.baselineDigest ||
    result.receipt.declarationDigest !== input.declaration.declarationDigest
  ) {
    return;
  }
  return Object.freeze({ receipt: result.receipt, input: assessmentInput });
}

export function verifyAssurance(
  assurance: ChangeAssurance,
  evidence: AssuranceEvidence,
): boolean {
  try {
    return assurance.verify(
      Object.freeze({ receipt: evidence.receipt, assessment: evidence.input }),
    );
  } catch {
    return false;
  }
}
