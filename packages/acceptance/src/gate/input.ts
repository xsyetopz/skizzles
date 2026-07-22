import { isCandidateManifestDigest } from "@skizzles/candidate-manifest";
import { authorityEvaluation, isVerificationAuthority } from "../authority.ts";
import type {
  DeterministicFuzzConfig,
  VerificationAuthority,
  VerificationAuthorityKind,
  VerificationBindings,
  VerificationGateConfig,
  VerificationGateInput,
} from "../contract.ts";
import type { VerificationDigest } from "../digest.ts";
import { isDigest } from "../digest.ts";
import { fuzzScheduleDigest } from "../fuzz.ts";
import {
  boundedInteger,
  dataRecord,
  frozenArray,
  identifier,
  opaqueEvidence,
} from "../object.ts";

type AnyAuthority = VerificationAuthority<VerificationAuthorityKind>;

export function parseGateConfig(
  raw: unknown,
): VerificationGateConfig | undefined {
  const record = dataRecord(raw, [
    "authorityId",
    "sourceEvidence",
    "changeAssurance",
    "taskWorktree",
    "physicalEvidence",
    "originalTests",
    "mutation",
    "property",
    "coverageAuthority",
    "exclusions",
    "reviewer",
    "coverage",
    "fuzz",
    "limits",
  ]);
  if (record === undefined || !identifier(record["authorityId"])) return;
  const authorityEntries = [
    ["sourceEvidence", "source-evidence"],
    ["changeAssurance", "change-assurance"],
    ["taskWorktree", "task-worktree"],
    ["physicalEvidence", "physical-evidence"],
    ["originalTests", "original-tests"],
    ["mutation", "mutation"],
    ["property", "property"],
    ["coverageAuthority", "coverage"],
    ["exclusions", "exclusion"],
    ["reviewer", "reviewer"],
  ] as const;
  const authorities: AnyAuthority[] = [];
  for (const [key, kind] of authorityEntries) {
    const value = record[key];
    if (!isVerificationAuthority(value) || value.kind !== kind) return;
    authorities.push(value as AnyAuthority);
  }
  if (
    new Set(authorities).size !== authorities.length ||
    new Set(authorities.map(({ id }) => id)).size !== authorities.length ||
    new Set(authorities.map((authority) => authorityEvaluation(authority)))
      .size !== authorities.length
  )
    return;
  const coverage = dataRecord(record["coverage"], [
    "minimumNodeHits",
    "minimumLineHits",
    "minimumBranchHits",
  ]);
  const limits = dataRecord(record["limits"], [
    "modifiedNodes",
    "linesPerNode",
    "branchesPerNode",
    "mutationSitesPerNode",
    "variantsPerSite",
    "properties",
    "artifactBytes",
  ]);
  const fuzz = parseFuzzConfig(record["fuzz"]);
  if (
    coverage === undefined ||
    !boundedInteger(coverage["minimumNodeHits"], 1, 1_000_000) ||
    !boundedInteger(coverage["minimumLineHits"], 1, 1_000_000) ||
    !boundedInteger(coverage["minimumBranchHits"], 1, 1_000_000) ||
    limits === undefined ||
    !boundedInteger(limits["modifiedNodes"], 1, 100_000) ||
    !boundedInteger(limits["linesPerNode"], 1, 100_000) ||
    !boundedInteger(limits["branchesPerNode"], 0, 10_000) ||
    !boundedInteger(limits["mutationSitesPerNode"], 1, 10_000) ||
    !boundedInteger(limits["variantsPerSite"], 1, 1000) ||
    !boundedInteger(limits["properties"], 1, 10_000) ||
    !boundedInteger(limits["artifactBytes"], 1, 64 * 1024 * 1024) ||
    fuzz === undefined
  )
    return;
  return Object.freeze({
    authorityId: record["authorityId"],
    sourceEvidence: authorities[0] as VerificationGateConfig["sourceEvidence"],
    changeAssurance:
      authorities[1] as VerificationGateConfig["changeAssurance"],
    taskWorktree: authorities[2] as VerificationGateConfig["taskWorktree"],
    physicalEvidence:
      authorities[3] as VerificationGateConfig["physicalEvidence"],
    originalTests: authorities[4] as VerificationGateConfig["originalTests"],
    mutation: authorities[5] as VerificationGateConfig["mutation"],
    property: authorities[6] as VerificationGateConfig["property"],
    coverageAuthority:
      authorities[7] as VerificationGateConfig["coverageAuthority"],
    exclusions: authorities[8] as VerificationGateConfig["exclusions"],
    reviewer: authorities[9] as VerificationGateConfig["reviewer"],
    coverage: Object.freeze({
      minimumNodeHits: coverage["minimumNodeHits"],
      minimumLineHits: coverage["minimumLineHits"],
      minimumBranchHits: coverage["minimumBranchHits"],
    }),
    fuzz,
    limits: Object.freeze({
      modifiedNodes: limits["modifiedNodes"],
      linesPerNode: limits["linesPerNode"],
      branchesPerNode: limits["branchesPerNode"],
      mutationSitesPerNode: limits["mutationSitesPerNode"],
      variantsPerSite: limits["variantsPerSite"],
      properties: limits["properties"],
      artifactBytes: limits["artifactBytes"],
    }),
  });
}

export function parseGateInput(
  raw: unknown,
): VerificationGateInput | undefined {
  const record = dataRecord(raw, [
    "version",
    "taskId",
    "taskEpochDigest",
    "requestDigest",
    "repositoryId",
    "rootIdentity",
    "treeDigest",
    "baselineDigest",
    "candidateDigest",
    "candidateManifestDigest",
    "specLockDigest",
    "baselineManifestDigest",
    "evidence",
  ]);
  if (
    record === undefined ||
    record["version"] !== 1 ||
    !identifier(record["taskId"]) ||
    !identifier(record["repositoryId"]) ||
    !boundedText(record["rootIdentity"], 1024) ||
    !isCandidateManifestDigest(record["candidateManifestDigest"]) ||
    ![
      "taskEpochDigest",
      "requestDigest",
      "treeDigest",
      "baselineDigest",
      "candidateDigest",
      "specLockDigest",
      "baselineManifestDigest",
    ].every((key) => isDigest(record[key]))
  )
    return;
  const evidence = dataRecord(record["evidence"], [
    "source",
    "changeAssurance",
    "taskWorktree",
    "physical",
    "originalTests",
  ]);
  const taskReceipts = evidence && frozenArray(evidence["taskWorktree"]);
  if (
    evidence === undefined ||
    !opaqueEvidence(evidence["source"]) ||
    !opaqueEvidence(evidence["changeAssurance"]) ||
    taskReceipts === undefined ||
    taskReceipts.length !== 4 ||
    taskReceipts.some((value) => !opaqueEvidence(value)) ||
    !opaqueEvidence(evidence["physical"]) ||
    !opaqueEvidence(evidence["originalTests"])
  )
    return;
  return Object.freeze({
    version: 1 as const,
    taskId: record["taskId"],
    taskEpochDigest: record["taskEpochDigest"] as VerificationDigest,
    requestDigest: record["requestDigest"] as VerificationDigest,
    repositoryId: record["repositoryId"],
    rootIdentity: record["rootIdentity"],
    treeDigest: record["treeDigest"] as VerificationDigest,
    baselineDigest: record["baselineDigest"] as VerificationDigest,
    candidateDigest: record["candidateDigest"] as VerificationDigest,
    candidateManifestDigest: record["candidateManifestDigest"],
    specLockDigest: record["specLockDigest"] as VerificationDigest,
    baselineManifestDigest: record[
      "baselineManifestDigest"
    ] as VerificationDigest,
    evidence: Object.freeze({
      source: evidence["source"],
      changeAssurance: evidence["changeAssurance"],
      taskWorktree: Object.freeze([...taskReceipts]) as readonly object[],
      physical: evidence["physical"],
      originalTests: evidence["originalTests"],
    }),
  });
}

export function inputBindings(
  input: VerificationGateInput,
): VerificationBindings {
  return Object.freeze({
    taskId: input.taskId,
    taskEpochDigest: input.taskEpochDigest,
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    rootIdentity: input.rootIdentity,
    treeDigest: input.treeDigest,
    baselineDigest: input.baselineDigest,
    candidateDigest: input.candidateDigest,
    candidateManifestDigest: input.candidateManifestDigest,
    specLockDigest: input.specLockDigest,
    baselineManifestDigest: input.baselineManifestDigest,
  });
}

function parseFuzzConfig(raw: unknown): DeterministicFuzzConfig | undefined {
  const record = dataRecord(raw, [
    "rootSeed",
    "seeds",
    "casesPerSeed",
    "dimensions",
    "minimum",
    "maximum",
    "extremes",
  ]);
  const extremes = record && frozenArray(record["extremes"]);
  if (record === undefined || extremes === undefined) return;
  const config: DeterministicFuzzConfig = Object.freeze({
    rootSeed: record["rootSeed"] as number,
    seeds: record["seeds"] as number,
    casesPerSeed: record["casesPerSeed"] as number,
    dimensions: record["dimensions"] as number,
    minimum: record["minimum"] as number,
    maximum: record["maximum"] as number,
    extremes: Object.freeze([...extremes]) as readonly number[],
  });
  try {
    fuzzScheduleDigest(config);
  } catch {
    return;
  }
  return config;
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
  );
}
