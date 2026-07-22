import { type Digest, digestText } from "../digest.ts";
import { authenticateStructuralEvidenceReceipt } from "../evidence/structural.ts";
import type {
  CompilerChainLink,
  CompilerChainReceipt,
  StructuralEvidenceReceipt,
} from "../evidence/structural-contract.ts";
import type { BatchState, EngineConfig } from "./workflow-state.ts";

export function assembleStructuralEvidence(input: {
  readonly config: EngineConfig;
  readonly batch: BatchState;
  readonly astChanges: StructuralEvidenceReceipt["astChanges"];
  readonly modifiedNodes: StructuralEvidenceReceipt["modifiedNodes"];
  readonly baselineAggregateComplexity: number;
  readonly candidateAggregateComplexity: number;
  readonly aggregateIncrease: number;
}): StructuralEvidenceReceipt | "compiler-rejected" | "structural-rejected" {
  const compilerChain = createCompilerChain(input.batch);
  if (compilerChain === undefined) return "compiler-rejected";
  if (
    input.astChanges.length !==
      input.batch.targets.reduce(
        (count, target) => count + target.operations.length,
        0,
      ) ||
    !completeStructuralMap(input.astChanges, input.modifiedNodes)
  ) {
    return "structural-rejected";
  }
  const policyMaterial = {
    metricVersion: input.config.structuralPolicy.metricVersion,
    maxFunctionComplexity: input.config.structuralPolicy.maxFunctionComplexity,
    maxFunctionIncrease: input.config.structuralPolicy.maxFunctionIncrease,
    maxAggregateIncrease: input.config.structuralPolicy.maxAggregateIncrease,
  };
  const policy = Object.freeze({
    ...policyMaterial,
    policyDigest: digestText(JSON.stringify(policyMaterial)),
  });
  const material = {
    requestDigest: input.batch.request.requestDigest,
    repositoryId: input.batch.request.repository.id,
    rootIdentity: input.batch.request.repository.rootIdentity,
    treeDigest: input.batch.request.repository.treeDigest,
    configDigest: input.batch.request.repository.configDigest,
    targetSetDigest: input.batch.targetSetDigest,
    baselineCandidateSetDigest: input.batch.baselineCandidateSetDigest,
    candidateSetDigest: input.batch.candidateSetDigest,
    policy,
    astChanges: input.astChanges,
    modifiedNodes: input.modifiedNodes,
    baselineAggregateComplexity: input.baselineAggregateComplexity,
    candidateAggregateComplexity: input.candidateAggregateComplexity,
    aggregateIncrease: input.aggregateIncrease,
    compilerChain,
  };
  return authenticateStructuralEvidenceReceipt(
    Object.freeze({
      ...material,
      receiptDigest: digestText(JSON.stringify(material)),
    }),
  );
}

function createCompilerChain(
  batch: BatchState,
): CompilerChainReceipt | undefined {
  const expectedLinks = batch.steps.filter(
    ({ kind }) => kind === "edit" || kind === "format",
  );
  if (batch.compilerReceipts.length !== expectedLinks.length) return;
  const links: CompilerChainLink[] = [];
  let predecessorReceiptDigest: Digest | null = null;
  let predecessorCandidateSetDigest = batch.baselineCandidateSetDigest;
  for (let index = 0; index < batch.compilerReceipts.length; index += 1) {
    const receipt = batch.compilerReceipts[index];
    const expected = expectedLinks[index];
    if (
      receipt === undefined ||
      expected === undefined ||
      expected.epoch === undefined ||
      receipt.epoch !== expected.epoch ||
      receipt.epochKind !== expected.kind ||
      receipt.predecessorReceiptDigest !== predecessorReceiptDigest ||
      receipt.predecessorCandidateSetDigest !== predecessorCandidateSetDigest ||
      receipt.targetSetDigest !== batch.targetSetDigest ||
      digestText(JSON.stringify(receipt.targets.map(({ path }) => path))) !==
        batch.targetSetDigest ||
      digestText(
        JSON.stringify(
          receipt.targets.map(({ path, candidateDigest, semanticDigest }) => ({
            path,
            candidateDigest,
            semanticDigest,
          })),
        ),
      ) !== receipt.candidateSetDigest
    ) {
      return;
    }
    const material = {
      epoch: receipt.epoch,
      kind: receipt.epochKind,
      predecessorReceiptDigest,
      predecessorCandidateSetDigest,
      candidateSetDigest: receipt.candidateSetDigest,
      targetSetDigest: receipt.targetSetDigest,
      compilerReceiptDigest: receipt.receiptDigest,
    };
    links.push(
      Object.freeze({
        ...material,
        linkDigest: digestText(JSON.stringify(material)),
      }),
    );
    predecessorReceiptDigest = receipt.receiptDigest;
    predecessorCandidateSetDigest = receipt.candidateSetDigest;
  }
  if (predecessorCandidateSetDigest !== batch.candidateSetDigest) return;
  const material = {
    targetSetDigest: batch.targetSetDigest,
    baselineCandidateSetDigest: batch.baselineCandidateSetDigest,
    finalCandidateSetDigest: batch.candidateSetDigest,
    links: Object.freeze(links),
  };
  return Object.freeze({
    ...material,
    receiptDigest: digestText(JSON.stringify(material)),
  });
}

function completeStructuralMap(
  astChanges: StructuralEvidenceReceipt["astChanges"],
  modifiedNodes: StructuralEvidenceReceipt["modifiedNodes"],
): boolean {
  const changeDigests = new Set<Digest>();
  const changedPaths = new Set<string>();
  for (const { change } of astChanges) {
    if (
      changeDigests.has(change.changeDigest) ||
      change.path.length === 0 ||
      (change.baselineNode === null && change.candidateNode === null) ||
      change.changeDigest !==
        digestText(
          JSON.stringify({
            path: change.path,
            operation: change.operation,
            anchor: change.anchor,
            baselineNode: change.baselineNode,
            candidateNode: change.candidateNode,
          }),
        ) ||
      !validAstOperationShape(change)
    ) {
      return false;
    }
    changeDigests.add(change.changeDigest);
    changedPaths.add(change.path);
  }
  const nodeIds = new Set<Digest>();
  for (const node of modifiedNodes) {
    if (
      nodeIds.has(node.nodeId) ||
      !changedPaths.has(node.path) ||
      (node.baseline === null && node.candidate === null) ||
      node.branchIds.length !== new Set(node.branchIds).size ||
      node.mutationSites.length !==
        new Set(node.mutationSites.map(({ siteId }) => siteId)).size ||
      node.lineIds.length === 0 ||
      node.lineIds.length !== new Set(node.lineIds).size ||
      node.mutationSites.some(
        ({ variants }) =>
          variants.length === 0 ||
          variants.length !==
            new Set(variants.map(({ variantId }) => variantId)).size,
      ) ||
      node.branchIds.some(
        (branchId) =>
          !node.mutationSites.some((site) => site.branchId === branchId),
      )
    ) {
      return false;
    }
    nodeIds.add(node.nodeId);
  }
  for (const { change } of astChanges) {
    for (const identity of [change.baselineNode, change.candidateNode]) {
      if (
        identity !== null &&
        !mappedIdentity(change.path, identity, modifiedNodes)
      ) {
        return false;
      }
    }
  }
  return astChanges.length > 0;
}

function mappedIdentity(
  path: string,
  identity: NonNullable<
    StructuralEvidenceReceipt["astChanges"][number]["change"]["baselineNode"]
  >,
  modifiedNodes: StructuralEvidenceReceipt["modifiedNodes"],
): boolean {
  if (
    identity.declarationKind === "interface" ||
    identity.declarationKind === "type"
  ) {
    return true;
  }
  return modifiedNodes.some((node) => {
    if (node.path !== path) return false;
    if (identity.declarationKind === "function") {
      return node.functionKey.split("/").includes(`function:${identity.name}`);
    }
    if (identity.declarationKind === "class") {
      return node.functionKey.split("/").includes(`class:${identity.name}`);
    }
    return node.kind === "module-initializer";
  });
}

function validAstOperationShape(
  change: StructuralEvidenceReceipt["astChanges"][number]["change"],
): boolean {
  if (change.operation === "delete") {
    return change.baselineNode !== null && change.candidateNode === null;
  }
  if (
    change.operation === "insert-before" ||
    change.operation === "insert-after"
  ) {
    return change.baselineNode === null && change.candidateNode !== null;
  }
  return change.baselineNode !== null && change.candidateNode !== null;
}
