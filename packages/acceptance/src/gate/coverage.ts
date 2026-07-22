import type { CandidateManifestDigest } from "@skizzles/candidate-manifest";
import type {
  VerificationBindings,
  VerificationCoverageThresholds,
  VerificationGateFailureCode,
} from "../contract.ts";
import type { VerificationDigest } from "../digest.ts";
import { digestValue, isDigest } from "../digest.ts";
import {
  boundedInteger,
  dataRecord,
  frozenArray,
  identifier,
} from "../object.ts";
import { validReport } from "./report.ts";
import type { SourceReport } from "./source.ts";

export interface CoverageReport {
  readonly evidenceDigest: VerificationDigest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly structuralReceiptDigest: VerificationDigest;
  readonly profileReceiptDigest: VerificationDigest;
  readonly coverageObjectiveDigest: VerificationDigest;
  readonly nodes: readonly Readonly<{
    nodeId: string;
    hits: number;
    lines: readonly Readonly<{
      lineId: VerificationDigest;
      hits: number;
    }>[];
    branches: readonly Readonly<{ branchId: string; hits: number }>[];
  }>[];
}

export function createCoverageObjective(
  source: SourceReport,
  profileReceiptDigest: VerificationDigest,
  thresholds: VerificationCoverageThresholds,
) {
  const objective = Object.freeze({
    structuralReceiptDigest: source.structuralReceiptDigest,
    profileReceiptDigest,
    modifiedNodes: Object.freeze(
      source.modifiedNodes.map(({ nodeId, lineIds, branchIds }) =>
        Object.freeze({ nodeId, lineIds, branchIds }),
      ),
    ),
    thresholds,
  });
  return Object.freeze({
    ...objective,
    coverageObjectiveDigest: digestValue(objective),
  });
}

export function modifiedLineCount(source: SourceReport): number {
  return source.modifiedNodes.reduce(
    (count, node) => count + node.lineIds.length,
    0,
  );
}

export function parseCoverageReport(
  raw: unknown,
  bindings: VerificationBindings,
  source: SourceReport,
  profileReceiptDigest: VerificationDigest,
  coverageObjectiveDigest: VerificationDigest,
): CoverageReport | undefined {
  const record = validReport(
    raw,
    [
      "status",
      "bindingDigest",
      "evidenceDigest",
      "candidateManifestDigest",
      "structuralReceiptDigest",
      "profileReceiptDigest",
      "coverageObjectiveDigest",
      "nodes",
    ],
    bindings,
  );
  if (
    record === undefined ||
    !isDigest(record["evidenceDigest"]) ||
    record["candidateManifestDigest"] !== bindings.candidateManifestDigest ||
    record["structuralReceiptDigest"] !== source.structuralReceiptDigest ||
    record["profileReceiptDigest"] !== profileReceiptDigest ||
    record["coverageObjectiveDigest"] !== coverageObjectiveDigest
  )
    return;
  const rawNodes = frozenArray(record["nodes"]);
  if (rawNodes === undefined || rawNodes.length !== source.modifiedNodes.length)
    return;
  const expectedNodes = new Map(
    source.modifiedNodes.map((node) => [
      node.nodeId,
      Object.freeze({
        lineIds: new Set(node.lineIds),
        branchIds: new Set(node.branchIds),
      }),
    ]),
  );
  const seenNodes = new Set<string>();
  const nodes: CoverageReport["nodes"][number][] = [];
  for (const value of rawNodes) {
    const node = dataRecord(value, ["nodeId", "hits", "lines", "branches"]);
    if (
      node === undefined ||
      !identifier(node["nodeId"]) ||
      seenNodes.has(node["nodeId"]) ||
      !boundedInteger(node["hits"], 0, Number.MAX_SAFE_INTEGER)
    )
      return;
    const expected = expectedNodes.get(node["nodeId"]);
    const rawLines = frozenArray(node["lines"]);
    const rawBranches = frozenArray(node["branches"]);
    if (
      expected === undefined ||
      rawLines === undefined ||
      rawLines.length !== expected.lineIds.size ||
      rawBranches === undefined ||
      rawBranches.length !== expected.branchIds.size
    )
      return;
    const lines: CoverageReport["nodes"][number]["lines"][number][] = [];
    const seenLines = new Set<VerificationDigest>();
    for (const rawLine of rawLines) {
      const line = dataRecord(rawLine, ["lineId", "hits"]);
      if (
        line === undefined ||
        !isDigest(line["lineId"]) ||
        !expected.lineIds.has(line["lineId"]) ||
        seenLines.has(line["lineId"]) ||
        !boundedInteger(line["hits"], 0, Number.MAX_SAFE_INTEGER)
      )
        return;
      seenLines.add(line["lineId"]);
      lines.push(Object.freeze({ lineId: line["lineId"], hits: line["hits"] }));
    }
    const branches: CoverageReport["nodes"][number]["branches"][number][] = [];
    const seenBranches = new Set<string>();
    for (const rawBranch of rawBranches) {
      const branch = dataRecord(rawBranch, ["branchId", "hits"]);
      if (
        branch === undefined ||
        !identifier(branch["branchId"]) ||
        !expected.branchIds.has(branch["branchId"]) ||
        seenBranches.has(branch["branchId"]) ||
        !boundedInteger(branch["hits"], 0, Number.MAX_SAFE_INTEGER)
      )
        return;
      seenBranches.add(branch["branchId"]);
      branches.push(
        Object.freeze({ branchId: branch["branchId"], hits: branch["hits"] }),
      );
    }
    seenNodes.add(node["nodeId"]);
    nodes.push(
      Object.freeze({
        nodeId: node["nodeId"],
        hits: node["hits"],
        lines: Object.freeze(lines),
        branches: Object.freeze(branches),
      }),
    );
  }
  return Object.freeze({
    evidenceDigest: record["evidenceDigest"],
    candidateManifestDigest: bindings.candidateManifestDigest,
    structuralReceiptDigest: source.structuralReceiptDigest,
    profileReceiptDigest,
    coverageObjectiveDigest,
    nodes: Object.freeze(nodes),
  });
}

export function coverageObjectiveFailures(
  coverage: CoverageReport,
  thresholds: VerificationCoverageThresholds,
): readonly VerificationGateFailureCode[] {
  const failures: VerificationGateFailureCode[] = [];
  if (coverage.nodes.some(({ hits }) => hits < thresholds.minimumNodeHits)) {
    failures.push("MODIFIED_NODE_UNCOVERED");
  }
  if (
    coverage.nodes.some(({ lines }) =>
      lines.some(({ hits }) => hits < thresholds.minimumLineHits),
    )
  ) {
    failures.push("MODIFIED_LINE_UNCOVERED");
  }
  if (
    coverage.nodes.some(({ branches }) =>
      branches.some(({ hits }) => hits < thresholds.minimumBranchHits),
    )
  ) {
    failures.push("MODIFIED_BRANCH_UNCOVERED");
  }
  return Object.freeze(failures);
}
