import type { VerificationAuthorityRequest } from "@skizzles/acceptance";
import type { TaskWorktreeVerificationReceipt } from "@skizzles/task-worktree";
import { exactKeys, isRecord } from "../../../codec.ts";
import { digestValue } from "../../../digest.ts";

type CandidateKind = "coverage" | "mutation" | "property";
export type OriginalReceiptResolver = (
  request: VerificationAuthorityRequest,
  value: unknown,
) => TaskWorktreeVerificationReceipt | undefined;
export type CandidateReceiptResolver = (
  request: VerificationAuthorityRequest,
  receiptDigest: unknown,
  kind: CandidateKind,
) => TaskWorktreeVerificationReceipt | undefined;

export function originalReport(
  request: VerificationAuthorityRequest,
  resolve: OriginalReceiptResolver,
): unknown {
  const payload = record(request.payload, [
    "evidence",
    "profileReceiptDigest",
    "viewDigest",
  ]);
  if (payload === undefined) return;
  const receipt = resolve(request, payload["evidence"]);
  if (
    receipt === undefined ||
    payload["profileReceiptDigest"] !== receipt.receiptDigest ||
    payload["viewDigest"] !== receipt.viewReceiptDigest
  ) {
    return;
  }
  const report = receipt.artifact.report;
  if (
    report.kind !== "original-tests" ||
    report.passedCount + report.failedCount < 1
  ) {
    return;
  }
  return Object.freeze({
    status: "valid" as const,
    bindingDigest: request.bindingDigest,
    evidenceDigest: digestValue({
      profileReceiptDigest: receipt.receiptDigest,
      artifactReceiptDigest: receipt.artifact.receiptDigest,
    }),
    candidateManifestDigest: receipt.candidateManifestDigest,
    baselineManifestDigest: report.baselineTestManifestDigest,
    candidateDigest: receipt.candidateDigest,
    productionOverlayDigest: report.productionOverlayDigest,
    isolationDigest: report.containerEvidenceDigest,
    testCount: report.passedCount + report.failedCount,
    passed: report.outcome === "passed" && report.failedCount === 0,
    profileReceiptDigest: receipt.receiptDigest,
    viewDigest: receipt.viewReceiptDigest,
  });
}

export function mutationReport(
  request: VerificationAuthorityRequest,
  resolve: CandidateReceiptResolver,
): unknown {
  const payload = record(request.payload, [
    "structuralReceiptDigest",
    "profileReceiptDigest",
    "inventory",
    "inventoryDigest",
  ]);
  if (payload === undefined) return;
  const receipt = resolve(request, payload["profileReceiptDigest"], "mutation");
  if (receipt === undefined) return;
  const report = receipt.artifact.report;
  if (
    report.kind !== "mutation" ||
    report.inventoryDigest !== payload["inventoryDigest"]
  ) {
    return;
  }
  return Object.freeze({
    status: "valid" as const,
    bindingDigest: request.bindingDigest,
    evidenceDigest: evidenceDigest(receipt),
    candidateManifestDigest: receipt.candidateManifestDigest,
    inventoryDigest: report.inventoryDigest,
    profileReceiptDigest: receipt.receiptDigest,
    outcomes: report.outcomes,
  });
}

export function propertyReport(
  request: VerificationAuthorityRequest,
  resolve: CandidateReceiptResolver,
): unknown {
  const payload = record(request.payload, [
    "structuralReceiptDigest",
    "profileReceiptDigest",
    "modifiedNodes",
    "fuzz",
    "seedScheduleDigest",
    "requiredRandomCaseCount",
    "requiredCaseCount",
    "requiredExtremeVectorDigests",
  ]);
  if (payload === undefined) return;
  const receipt = resolve(request, payload["profileReceiptDigest"], "property");
  if (receipt === undefined) return;
  const report = receipt.artifact.report;
  const requiredExtremes = frozenArray(payload["requiredExtremeVectorDigests"]);
  if (
    report.kind !== "property" ||
    report.seedScheduleDigest !== payload["seedScheduleDigest"] ||
    report.requiredCaseCount !== payload["requiredCaseCount"] ||
    requiredExtremes === undefined ||
    requiredExtremes.some((value) => !digest(value)) ||
    report.extremeVectorInventoryDigest !== digestValue(requiredExtremes) ||
    report.properties.some(
      (property) =>
        property.executedExtremeVectorDigests.length !==
          requiredExtremes.length ||
        property.executedExtremeVectorDigests.some(
          (value, index) => value !== requiredExtremes[index],
        ),
    )
  ) {
    return;
  }
  return Object.freeze({
    status: "valid" as const,
    bindingDigest: request.bindingDigest,
    evidenceDigest: evidenceDigest(receipt),
    candidateManifestDigest: receipt.candidateManifestDigest,
    structuralReceiptDigest: payload["structuralReceiptDigest"],
    profileReceiptDigest: receipt.receiptDigest,
    specLockDigest: receipt.specificationLockDigest,
    seedScheduleDigest: report.seedScheduleDigest,
    requiredCaseCount: report.requiredCaseCount,
    extremeVectorInventoryDigest: report.extremeVectorInventoryDigest,
    properties: report.properties,
  });
}

export function coverageReport(
  request: VerificationAuthorityRequest,
  resolve: CandidateReceiptResolver,
): unknown {
  const payload = record(request.payload, [
    "structuralReceiptDigest",
    "profileReceiptDigest",
    "modifiedNodes",
    "thresholds",
    "coverageObjectiveDigest",
  ]);
  if (payload === undefined) return;
  const receipt = resolve(request, payload["profileReceiptDigest"], "coverage");
  if (receipt === undefined || receipt.artifact.report.kind !== "coverage") {
    return;
  }
  const objectiveDigest = digestValue({
    structuralReceiptDigest: payload["structuralReceiptDigest"],
    profileReceiptDigest: payload["profileReceiptDigest"],
    modifiedNodes: payload["modifiedNodes"],
    thresholds: payload["thresholds"],
  });
  if (payload["coverageObjectiveDigest"] !== objectiveDigest) {
    return;
  }
  return Object.freeze({
    status: "valid" as const,
    bindingDigest: request.bindingDigest,
    evidenceDigest: evidenceDigest(receipt),
    candidateManifestDigest: receipt.candidateManifestDigest,
    structuralReceiptDigest: payload["structuralReceiptDigest"],
    profileReceiptDigest: receipt.receiptDigest,
    coverageObjectiveDigest: objectiveDigest,
    nodes: receipt.artifact.report.nodes,
  });
}

function evidenceDigest(receipt: TaskWorktreeVerificationReceipt) {
  return digestValue({
    profileReceiptDigest: receipt.receiptDigest,
    artifactReceiptDigest: receipt.artifact.receiptDigest,
  });
}

function record(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) && exactKeys(value, keys) ? value : undefined;
}

function frozenArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) && Object.isFrozen(value) ? value : undefined;
}

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
