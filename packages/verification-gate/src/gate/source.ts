import {
  type CandidateManifestDigest,
  isCandidateManifestDigest,
} from "@skizzles/candidate-manifest";
import type {
  MutationKind,
  VerificationBindings,
  VerificationGateLimits,
} from "../contract.ts";
import type { VerificationDigest } from "../digest.ts";
import { digestValue, isDigest } from "../digest.ts";
import { dataRecord, frozenArray, identifier } from "../object.ts";
import { digests, identifierArray, validReport } from "./report.ts";

const compilerChainDigestField = "compilerChainDigest";

export interface MutationSite {
  readonly siteId: string;
  readonly kind: MutationKind;
  readonly variants: readonly Readonly<{ variantId: string }>[];
}

export interface ModifiedNode {
  readonly nodeId: string;
  readonly nodeDigest: VerificationDigest;
  readonly pathDigest: VerificationDigest;
  readonly kind: string;
  readonly lineIds: readonly VerificationDigest[];
  readonly branchIds: readonly string[];
  readonly mutationSites: readonly MutationSite[];
  readonly complexityDigest: VerificationDigest;
}

export interface ExpectedMutant {
  readonly mutantId: VerificationDigest;
  readonly nodeId: string;
  readonly siteId: string;
  readonly kind: MutationKind;
  readonly variantId: string;
}

export interface SourceReport {
  readonly evidenceDigest: VerificationDigest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly structuralReceiptDigest: VerificationDigest;
  readonly compilerChainDigest: VerificationDigest;
  readonly complexityEvidenceDigest: VerificationDigest;
  readonly modifiedNodes: readonly ModifiedNode[];
}

export function parseSourceReport(
  raw: unknown,
  bindings: VerificationBindings,
  limits: VerificationGateLimits,
): SourceReport | undefined {
  const record = validReport(
    raw,
    [
      "status",
      "bindingDigest",
      "evidenceDigest",
      "candidateManifestDigest",
      "structuralReceiptDigest",
      compilerChainDigestField,
      "complexityEvidenceDigest",
      "modifiedNodes",
    ],
    bindings,
  );
  if (
    record === undefined ||
    !isCandidateManifestDigest(record["candidateManifestDigest"]) ||
    !digests(record, [
      "evidenceDigest",
      "structuralReceiptDigest",
      compilerChainDigestField,
      "complexityEvidenceDigest",
    ])
  ) {
    return;
  }
  const nodesRaw = frozenArray(record["modifiedNodes"]);
  if (
    nodesRaw === undefined ||
    nodesRaw.length < 1 ||
    nodesRaw.length > limits.modifiedNodes
  ) {
    return;
  }
  const nodes: ModifiedNode[] = [];
  const nodeIds = new Set<string>();
  for (const rawNode of nodesRaw) {
    const node = parseModifiedNode(rawNode, limits);
    if (node === undefined || nodeIds.has(node.nodeId)) return;
    nodeIds.add(node.nodeId);
    nodes.push(node);
  }
  return Object.freeze({
    evidenceDigest: record["evidenceDigest"] as VerificationDigest,
    candidateManifestDigest: record["candidateManifestDigest"],
    structuralReceiptDigest: record[
      "structuralReceiptDigest"
    ] as VerificationDigest,
    compilerChainDigest: record[compilerChainDigestField] as VerificationDigest,
    complexityEvidenceDigest: record[
      "complexityEvidenceDigest"
    ] as VerificationDigest,
    modifiedNodes: Object.freeze(nodes),
  });
}

export function deriveMutationInventory(
  source: SourceReport,
): readonly ExpectedMutant[] {
  const mutants: ExpectedMutant[] = [];
  for (const node of source.modifiedNodes) {
    for (const site of node.mutationSites) {
      for (const variant of site.variants) {
        const material = Object.freeze({
          structuralReceiptDigest: source.structuralReceiptDigest,
          nodeId: node.nodeId,
          nodeDigest: node.nodeDigest,
          siteId: site.siteId,
          kind: site.kind,
          variantId: variant.variantId,
        });
        mutants.push(
          Object.freeze({
            mutantId: digestValue(material),
            nodeId: node.nodeId,
            siteId: site.siteId,
            kind: site.kind,
            variantId: variant.variantId,
          }),
        );
      }
    }
  }
  return Object.freeze(mutants);
}

function parseModifiedNode(
  raw: unknown,
  limits: VerificationGateLimits,
): ModifiedNode | undefined {
  const node = dataRecord(raw, [
    "nodeId",
    "nodeDigest",
    "pathDigest",
    "kind",
    "lineIds",
    "branchIds",
    "mutationSites",
    "complexityDigest",
  ]);
  if (
    node === undefined ||
    !identifier(node["nodeId"]) ||
    !isDigest(node["nodeDigest"]) ||
    !isDigest(node["pathDigest"]) ||
    !identifier(node["kind"]) ||
    !isDigest(node["complexityDigest"])
  ) {
    return;
  }
  const branchIds = identifierArray(node["branchIds"]);
  const lineIds = digestArray(node["lineIds"]);
  const sitesRaw = frozenArray(node["mutationSites"]);
  if (
    lineIds === undefined ||
    lineIds.length < 1 ||
    lineIds.length > limits.linesPerNode ||
    branchIds === undefined ||
    branchIds.length > limits.branchesPerNode ||
    sitesRaw === undefined ||
    sitesRaw.length < 1 ||
    sitesRaw.length > limits.mutationSitesPerNode
  ) {
    return;
  }
  const sites: MutationSite[] = [];
  const siteIds = new Set<string>();
  for (const value of sitesRaw) {
    const site = dataRecord(value, ["siteId", "kind", "variants"]);
    if (
      site === undefined ||
      !identifier(site["siteId"]) ||
      siteIds.has(site["siteId"]) ||
      !isMutationKind(site["kind"])
    ) {
      return;
    }
    const variantsRaw = frozenArray(site["variants"]);
    if (
      variantsRaw === undefined ||
      variantsRaw.length < 1 ||
      variantsRaw.length > limits.variantsPerSite
    ) {
      return;
    }
    const variants: Array<Readonly<{ variantId: string }>> = [];
    const variantIds = new Set<string>();
    for (const rawVariant of variantsRaw) {
      const variant = dataRecord(rawVariant, ["variantId"]);
      if (
        variant === undefined ||
        !identifier(variant["variantId"]) ||
        variantIds.has(variant["variantId"])
      ) {
        return;
      }
      variantIds.add(variant["variantId"]);
      variants.push(Object.freeze({ variantId: variant["variantId"] }));
    }
    siteIds.add(site["siteId"]);
    sites.push(
      Object.freeze({
        siteId: site["siteId"],
        kind: site["kind"],
        variants: Object.freeze(variants),
      }),
    );
  }
  return Object.freeze({
    nodeId: node["nodeId"],
    nodeDigest: node["nodeDigest"],
    pathDigest: node["pathDigest"],
    kind: node["kind"],
    lineIds,
    branchIds,
    mutationSites: Object.freeze(sites),
    complexityDigest: node["complexityDigest"],
  });
}

function digestArray(raw: unknown): readonly VerificationDigest[] | undefined {
  const values = frozenArray(raw);
  if (values === undefined) return;
  const result: VerificationDigest[] = [];
  const seen = new Set<VerificationDigest>();
  for (const value of values) {
    if (!isDigest(value) || seen.has(value)) return;
    seen.add(value);
    result.push(value);
  }
  return Object.freeze(result);
}

function isMutationKind(value: unknown): value is MutationKind {
  return (
    value === "operator" ||
    value === "condition" ||
    value === "boundary" ||
    value === "return"
  );
}
