import { createCandidateManifest } from "@skizzles/candidate-manifest";
import {
  isChangeAssuranceReceipt,
  isIndependentSecurityReviewAuthority,
  isSecurityPolicyLinter,
  isSecurityPolicyLintReceipt,
  isSecurityReviewReceipt,
} from "@skizzles/change-assurance";
import {
  isSourceEngineering,
  isStructuralEvidenceReceipt,
} from "@skizzles/source-engineering";
import { isRecord } from "../../codec.ts";
import { digestBytes } from "../../digest.ts";
import type {
  WorkflowVerificationAuthorityConfig,
  WorkflowVerificationAuthorityCreationResult,
  WorkflowVerificationEvaluationInput,
  WorkflowVerificationMaterialInput,
} from "./contract.ts";

const authorityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export function validVerificationAuthorityConfig(
  config: WorkflowVerificationAuthorityConfig,
): boolean {
  return (
    isRecord(config) &&
    isRecord(config.exclusions) &&
    isRecord(config.reviewer) &&
    authorityIdPattern.test(config.authorityId) &&
    digestPattern.test(config.containerImageDigest) &&
    config.exclusions !== config.reviewer &&
    authorityIdPattern.test(config.exclusions.id) &&
    authorityIdPattern.test(config.reviewer.id) &&
    config.exclusions.id !== config.reviewer.id &&
    typeof config.exclusions.evaluate === "function" &&
    typeof config.reviewer.evaluate === "function" &&
    config.exclusions.evaluate !== config.reviewer.evaluate
  );
}

export function validVerificationMaterial(
  input: WorkflowVerificationMaterialInput,
): boolean {
  const { source, changeAssurance: assurance, physical } = input;
  return (
    Object.isFrozen(source) &&
    Object.isFrozen(source.summary) &&
    Object.isFrozen(source.artifacts) &&
    Object.isFrozen(source.receipt) &&
    Object.isFrozen(assurance) &&
    Object.isFrozen(physical) &&
    isSourceEngineering(source.authority) &&
    isStructuralEvidenceReceipt(source.summary.structuralReceipt) &&
    isChangeAssuranceReceipt(assurance.receipt) &&
    isSecurityPolicyLinter(assurance.linter) &&
    isSecurityPolicyLintReceipt(assurance.lintReceipt) &&
    isIndependentSecurityReviewAuthority(assurance.reviewer) &&
    isSecurityReviewReceipt(assurance.reviewReceipt) &&
    ((physical.mode === "not-applicable" &&
      physical.declarationDigests.length === 0) ||
      (physical.mode === "attested" &&
        physical.declarationDigests.length > 0 &&
        physical.declarationDigests.length === physical.receiptDigests.length &&
        typeof physical.verify === "function"))
  );
}

export function verificationEvaluationBinds(
  input: WorkflowVerificationEvaluationInput,
  material: WorkflowVerificationMaterialInput,
): boolean {
  const source = material.source.summary;
  const assurance = material.changeAssurance;
  const physical = material.physical;
  return (
    input.receipts.ordered.length === 4 &&
    input.receipts.ordered[0] === input.receipts.originalTests &&
    input.receipts.ordered[1] === input.receipts.mutation &&
    input.receipts.ordered[2] === input.receipts.property &&
    input.receipts.ordered[3] === input.receipts.coverage &&
    input.bindings.requestDigest === source.requestDigest &&
    input.bindings.requestDigest === assurance.receipt.requestDigest &&
    input.bindings.repositoryId === source.structuralReceipt.repositoryId &&
    input.bindings.repositoryId === assurance.receipt.repositoryId &&
    input.bindings.rootIdentity === source.structuralReceipt.rootIdentity &&
    input.bindings.treeDigest === source.structuralReceipt.treeDigest &&
    input.bindings.treeDigest === assurance.receipt.treeDigest &&
    input.bindings.baselineDigest === assurance.receipt.baselineDigest &&
    assurance.receipt.candidateDigest ===
      assurance.lintReceipt.candidateDigest &&
    assuranceCandidateManifestDigest(assurance.assessment) ===
      source.candidateManifestDigest &&
    input.bindings.candidateManifestDigest === source.candidateManifestDigest &&
    input.bindings.specLockDigest ===
      input.receipts.originalTests.specificationLockDigest &&
    input.bindings.baselineManifestDigest ===
      input.receipts.originalTests.baselineTestManifestDigest &&
    receiptsBindEvaluation(input, source.candidateManifestDigest) &&
    (physical.mode === "not-applicable" ||
      physical.candidateDigest === input.bindings.candidateDigest)
  );
}

function receiptsBindEvaluation(
  input: WorkflowVerificationEvaluationInput,
  candidateManifestDigest: `sha256:${string}`,
): boolean {
  const { bindings, receipts } = input;
  const expected = [
    [
      receipts.originalTests,
      "original-tests",
      receipts.objectives.originalTests,
    ],
    [receipts.mutation, "mutation", receipts.objectives.mutation],
    [receipts.property, "property", receipts.objectives.property],
    [receipts.coverage, "coverage", receipts.objectives.coverage],
  ] as const;
  const authorityId = receipts.originalTests.authorityId;
  const candidateTestManifestDigest =
    receipts.originalTests.candidateTestManifestDigest;
  return expected.every(
    ([receipt, kind, objective]) =>
      receipt.authorityId === authorityId &&
      receipt.taskId === bindings.taskId &&
      receipt.taskEpochDigest === bindings.taskEpochDigest &&
      receipt.requestDigest === bindings.requestDigest &&
      receipt.repositoryId === bindings.repositoryId &&
      receipt.rootIdentity === bindings.rootIdentity &&
      receipt.treeDigest === bindings.treeDigest &&
      receipt.baselineDigest === bindings.baselineDigest &&
      receipt.candidateDigest === bindings.candidateDigest &&
      receipt.candidateManifestDigest === candidateManifestDigest &&
      receipt.baselineTestManifestDigest === bindings.baselineManifestDigest &&
      receipt.candidateTestManifestDigest === candidateTestManifestDigest &&
      receipt.specificationLockDigest === bindings.specLockDigest &&
      receipt.profileKind === kind &&
      receipt.artifact.objectiveDigest === receipt.objectiveDigest &&
      receiptObjectiveBinds(receipt, objective),
  );
}

function receiptObjectiveBinds(
  receipt: WorkflowVerificationEvaluationInput["receipts"]["ordered"][number],
  objective: WorkflowVerificationEvaluationInput["receipts"]["objectives"][keyof WorkflowVerificationEvaluationInput["receipts"]["objectives"]],
): boolean {
  if (
    receipt.objective.kind !== objective.kind ||
    receipt.objective.structuralReceiptDigest !==
      objective.structuralReceiptDigest
  ) {
    return false;
  }
  if (objective.kind === "original-tests") {
    return (
      receipt.objective.kind === "original-tests" &&
      receipt.objective.containerImageDigest === objective.containerImageDigest
    );
  }
  return JSON.stringify(receipt.objective) === JSON.stringify(objective);
}

function assuranceCandidateManifestDigest(
  assessment: WorkflowVerificationMaterialInput["changeAssurance"]["assessment"],
): `sha256:${string}` | undefined {
  try {
    return createCandidateManifest(
      assessment.targets.map(({ path, operation, candidateBytes }) =>
        Object.freeze({
          path,
          operation,
          contentDigest:
            operation === "delete"
              ? null
              : candidateBytes === null
                ? null
                : digestBytes(Uint8Array.from(candidateBytes)),
        }),
      ),
    ).manifestDigest;
  } catch {
    return void 0;
  }
}

export function verificationRoleId(authorityId: string, role: string): string {
  return `${authorityId}/${role}`;
}

export function invalidVerificationConfig(): WorkflowVerificationAuthorityCreationResult {
  return Object.freeze({ status: "rejected" as const, code: "INVALID_CONFIG" });
}

export function isVerificationDigest(
  value: unknown,
): value is `sha256:${string}` {
  return typeof value === "string" && digestPattern.test(value);
}
