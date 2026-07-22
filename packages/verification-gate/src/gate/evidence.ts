import {
  type CandidateManifestDigest,
  isCandidateManifestDigest,
} from "@skizzles/candidate-manifest";
import type {
  MutationOutcome,
  VerificationBindings,
  VerificationGateLimits,
} from "../contract.ts";
import type { VerificationDigest } from "../digest.ts";
import { digestValue, isDigest } from "../digest.ts";
import {
  boundedInteger,
  dataRecord,
  frozenArray,
  identifier,
} from "../object.ts";
import { digests, identifierArray, validReport } from "./report.ts";
import type { ExpectedMutant, SourceReport } from "./source.ts";

export interface TaskWorktreeReport {
  readonly evidenceDigest: VerificationDigest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly viewDigest: VerificationDigest;
  readonly baselineTestManifestDigest: VerificationDigest;
  readonly candidateTestManifestDigest: VerificationDigest;
  readonly specificationLockDigest: VerificationDigest;
  readonly artifactReceiptDigest: VerificationDigest;
  readonly profileReceiptDigests: Readonly<{
    originalTests: VerificationDigest;
    mutation: VerificationDigest;
    property: VerificationDigest;
    coverage: VerificationDigest;
  }>;
  readonly profileCandidateManifestDigests: Readonly<{
    originalTests: CandidateManifestDigest;
    mutation: CandidateManifestDigest;
    property: CandidateManifestDigest;
    coverage: CandidateManifestDigest;
  }>;
  readonly artifactByteLength: number;
}

export interface MutationReport {
  readonly evidenceDigest: VerificationDigest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly inventoryDigest: VerificationDigest;
  readonly profileReceiptDigest: VerificationDigest;
  readonly outcomes: readonly Readonly<{
    mutantId: VerificationDigest;
    outcome: MutationOutcome;
    evidenceDigest: VerificationDigest;
  }>[];
}

export interface PropertyReport {
  readonly evidenceDigest: VerificationDigest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly structuralReceiptDigest: VerificationDigest;
  readonly profileReceiptDigest: VerificationDigest;
  readonly seedScheduleDigest: VerificationDigest;
  readonly requiredCaseCount: number;
  readonly extremeVectorInventoryDigest: VerificationDigest;
  readonly properties: readonly Readonly<{
    propertyId: string;
    nodeIds: readonly string[];
    branchIds: readonly string[];
    executedCases: number;
    executedRandomCases: number;
    executedExtremeCases: number;
    completed: true;
    executedExtremeVectorDigests: readonly VerificationDigest[];
    counterexampleDigest: VerificationDigest | null;
  }>[];
}

export function parseSimpleEvidenceReport(
  raw: unknown,
  bindings: VerificationBindings,
  extraKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  return validReport(
    raw,
    ["status", "bindingDigest", "evidenceDigest", ...extraKeys],
    bindings,
  );
}

export function parseTaskWorktreeReport(
  raw: unknown,
  bindings: VerificationBindings,
  limits: VerificationGateLimits,
): TaskWorktreeReport | undefined {
  const record = validReport(
    raw,
    [
      "status",
      "bindingDigest",
      "evidenceDigest",
      "candidateManifestDigest",
      "viewDigest",
      "baselineTestManifestDigest",
      "candidateTestManifestDigest",
      "specificationLockDigest",
      "artifactReceiptDigest",
      "profileReceiptDigests",
      "profileCandidateManifestDigests",
      "artifactByteLength",
    ],
    bindings,
  );
  if (
    record === undefined ||
    !digests(record, [
      "evidenceDigest",
      "viewDigest",
      "baselineTestManifestDigest",
      "candidateTestManifestDigest",
      "specificationLockDigest",
      "artifactReceiptDigest",
    ]) ||
    !isCandidateManifestDigest(record["candidateManifestDigest"]) ||
    !boundedInteger(record["artifactByteLength"], 0, limits.artifactBytes)
  )
    return;
  const profiles = dataRecord(record["profileReceiptDigests"], [
    "originalTests",
    "mutation",
    "property",
    "coverage",
  ]);
  const profileManifests = dataRecord(
    record["profileCandidateManifestDigests"],
    ["originalTests", "mutation", "property", "coverage"],
  );
  if (
    profiles === undefined ||
    !digests(profiles, ["originalTests", "mutation", "property", "coverage"]) ||
    profileManifests === undefined ||
    !["originalTests", "mutation", "property", "coverage"].every((key) =>
      isCandidateManifestDigest(profileManifests[key]),
    )
  )
    return;
  return Object.freeze({
    evidenceDigest: record["evidenceDigest"] as VerificationDigest,
    candidateManifestDigest: record["candidateManifestDigest"],
    viewDigest: record["viewDigest"] as VerificationDigest,
    baselineTestManifestDigest: record[
      "baselineTestManifestDigest"
    ] as VerificationDigest,
    candidateTestManifestDigest: record[
      "candidateTestManifestDigest"
    ] as VerificationDigest,
    specificationLockDigest: record[
      "specificationLockDigest"
    ] as VerificationDigest,
    artifactReceiptDigest: record[
      "artifactReceiptDigest"
    ] as VerificationDigest,
    profileReceiptDigests: Object.freeze({
      originalTests: profiles["originalTests"] as VerificationDigest,
      mutation: profiles["mutation"] as VerificationDigest,
      property: profiles["property"] as VerificationDigest,
      coverage: profiles["coverage"] as VerificationDigest,
    }),
    profileCandidateManifestDigests: Object.freeze({
      originalTests: profileManifests[
        "originalTests"
      ] as CandidateManifestDigest,
      mutation: profileManifests["mutation"] as CandidateManifestDigest,
      property: profileManifests["property"] as CandidateManifestDigest,
      coverage: profileManifests["coverage"] as CandidateManifestDigest,
    }),
    artifactByteLength: record["artifactByteLength"],
  });
}

export function parseMutationReport(
  raw: unknown,
  bindings: VerificationBindings,
  expected: readonly ExpectedMutant[],
  profileReceiptDigest: VerificationDigest,
): MutationReport | undefined {
  const record = validReport(
    raw,
    [
      "status",
      "bindingDigest",
      "evidenceDigest",
      "candidateManifestDigest",
      "inventoryDigest",
      "profileReceiptDigest",
      "outcomes",
    ],
    bindings,
  );
  const expectedDigest = digestValue(expected);
  if (
    record === undefined ||
    !isDigest(record["evidenceDigest"]) ||
    record["candidateManifestDigest"] !== bindings.candidateManifestDigest ||
    record["inventoryDigest"] !== expectedDigest ||
    record["profileReceiptDigest"] !== profileReceiptDigest
  )
    return;
  const outcomesRaw = frozenArray(record["outcomes"]);
  if (outcomesRaw === undefined || outcomesRaw.length !== expected.length)
    return;
  const expectedIds = new Set(expected.map(({ mutantId }) => mutantId));
  const seen = new Set<string>();
  const outcomes: MutationReport["outcomes"][number][] = [];
  for (const value of outcomesRaw) {
    const outcome = dataRecord(value, [
      "mutantId",
      "outcome",
      "evidenceDigest",
    ]);
    if (
      outcome === undefined ||
      !isDigest(outcome["mutantId"]) ||
      !expectedIds.has(outcome["mutantId"]) ||
      seen.has(outcome["mutantId"]) ||
      !isDigest(outcome["evidenceDigest"]) ||
      !isMutationOutcome(outcome["outcome"])
    )
      return;
    seen.add(outcome["mutantId"]);
    outcomes.push(
      Object.freeze({
        mutantId: outcome["mutantId"],
        outcome: outcome["outcome"],
        evidenceDigest: outcome["evidenceDigest"],
      }),
    );
  }
  return Object.freeze({
    evidenceDigest: record["evidenceDigest"],
    candidateManifestDigest: bindings.candidateManifestDigest,
    inventoryDigest: expectedDigest,
    profileReceiptDigest,
    outcomes: Object.freeze(outcomes),
  });
}

export function parsePropertyReport(
  raw: unknown,
  bindings: VerificationBindings,
  source: SourceReport,
  limits: VerificationGateLimits,
  profileReceiptDigest: VerificationDigest,
  requiredCaseCount: number,
  requiredRandomCaseCount: number,
  requiredExtremeVectorDigests: readonly VerificationDigest[],
): PropertyReport | undefined {
  const record = validReport(
    raw,
    [
      "status",
      "bindingDigest",
      "evidenceDigest",
      "candidateManifestDigest",
      "structuralReceiptDigest",
      "profileReceiptDigest",
      "specLockDigest",
      "seedScheduleDigest",
      "requiredCaseCount",
      "extremeVectorInventoryDigest",
      "properties",
    ],
    bindings,
  );
  if (
    record === undefined ||
    !isDigest(record["evidenceDigest"]) ||
    record["candidateManifestDigest"] !== bindings.candidateManifestDigest ||
    record["structuralReceiptDigest"] !== source.structuralReceiptDigest ||
    record["profileReceiptDigest"] !== profileReceiptDigest ||
    record["specLockDigest"] !== bindings.specLockDigest ||
    !isDigest(record["seedScheduleDigest"]) ||
    record["requiredCaseCount"] !== requiredCaseCount ||
    record["extremeVectorInventoryDigest"] !==
      digestValue(requiredExtremeVectorDigests)
  )
    return;
  const rawProperties = frozenArray(record["properties"]);
  if (
    rawProperties === undefined ||
    rawProperties.length < 1 ||
    rawProperties.length > limits.properties
  )
    return;
  const properties: PropertyReport["properties"][number][] = [];
  const propertyIds = new Set<string>();
  const nodeIds = new Set(source.modifiedNodes.map(({ nodeId }) => nodeId));
  const branchIds = new Set(
    source.modifiedNodes.flatMap(({ branchIds: values }) => values),
  );
  for (const value of rawProperties) {
    const property = dataRecord(value, [
      "propertyId",
      "nodeIds",
      "branchIds",
      "executedCases",
      "executedRandomCases",
      "executedExtremeCases",
      "completed",
      "executedExtremeVectorDigests",
      "counterexampleDigest",
    ]);
    if (
      property === undefined ||
      !identifier(property["propertyId"]) ||
      propertyIds.has(property["propertyId"]) ||
      property["executedCases"] !== requiredCaseCount ||
      property["executedRandomCases"] !== requiredRandomCaseCount ||
      property["executedExtremeCases"] !==
        requiredExtremeVectorDigests.length ||
      property["completed"] !== true ||
      !(
        property["counterexampleDigest"] === null ||
        isDigest(property["counterexampleDigest"])
      )
    )
      return;
    const executedExtremes = frozenArray(
      property["executedExtremeVectorDigests"],
    );
    if (
      executedExtremes === undefined ||
      executedExtremes.length !== requiredExtremeVectorDigests.length ||
      executedExtremes.some(
        (digest, index) =>
          !isDigest(digest) || digest !== requiredExtremeVectorDigests[index],
      )
    ) {
      return;
    }
    const reachedNodes = identifierArray(property["nodeIds"], nodeIds);
    const reachedBranches = identifierArray(property["branchIds"], branchIds);
    if (reachedNodes === undefined || reachedBranches === undefined) return;
    propertyIds.add(property["propertyId"]);
    properties.push(
      Object.freeze({
        propertyId: property["propertyId"],
        nodeIds: reachedNodes,
        branchIds: reachedBranches,
        executedCases: requiredCaseCount,
        executedRandomCases: requiredRandomCaseCount,
        executedExtremeCases: requiredExtremeVectorDigests.length,
        completed: true,
        executedExtremeVectorDigests: requiredExtremeVectorDigests,
        counterexampleDigest: property["counterexampleDigest"],
      }),
    );
  }
  return Object.freeze({
    evidenceDigest: record["evidenceDigest"],
    candidateManifestDigest: bindings.candidateManifestDigest,
    structuralReceiptDigest: source.structuralReceiptDigest,
    profileReceiptDigest,
    seedScheduleDigest: record["seedScheduleDigest"],
    requiredCaseCount,
    extremeVectorInventoryDigest: digestValue(requiredExtremeVectorDigests),
    properties: Object.freeze(properties),
  });
}

function isMutationOutcome(value: unknown): value is MutationOutcome {
  return (
    value === "killed" ||
    value === "survived" ||
    value === "timeout" ||
    value === "invalid"
  );
}
