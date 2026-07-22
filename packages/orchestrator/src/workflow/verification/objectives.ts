import { isStructuralEvidenceReceipt } from "@skizzles/source-engineering";
import {
  createDeterministicSeedSchedule,
  deterministicExtremeVectorDigests,
  deterministicFuzzCaseCount,
  deterministicFuzzRandomCaseCount,
} from "@skizzles/verification-gate";
import { digestValue } from "../../digest.ts";
import type {
  WorkflowVerificationAuthorityConfig,
  WorkflowVerificationMaterialInput,
} from "./contract.ts";
import type { WorkflowVerificationObjectives } from "./task-contract.ts";

export function deriveVerificationObjectives(
  input: WorkflowVerificationMaterialInput,
  config: WorkflowVerificationAuthorityConfig,
): WorkflowVerificationObjectives | undefined {
  const structural = input.source.summary.structuralReceipt;
  if (!isStructuralEvidenceReceipt(structural)) return;
  const inventory = structural.modifiedNodes.flatMap((node) =>
    node.mutationSites.flatMap((site) =>
      site.variants.map((variant) =>
        Object.freeze({
          mutantId: digestValue({
            structuralReceiptDigest: structural.receiptDigest,
            nodeId: node.nodeId,
            nodeDigest: node.nodeDigest,
            siteId: site.siteId,
            kind: site.kind,
            variantId: variant.variantId,
          }),
          nodeId: node.nodeId,
          siteId: site.siteId,
          kind: site.kind,
          variantId: variant.variantId,
        }),
      ),
    ),
  );
  if (inventory.length === 0) return;
  const nodeIds = Object.freeze(
    structural.modifiedNodes.map(({ nodeId }) => nodeId).sort(),
  );
  const branchIds = Object.freeze(
    structural.modifiedNodes.flatMap(({ branchIds }) => branchIds).sort(),
  );
  const seedScheduleDigest = digestValue({
    schedule: createDeterministicSeedSchedule(
      config.fuzz.rootSeed,
      config.fuzz.seeds,
    ),
    casesPerSeed: config.fuzz.casesPerSeed,
    dimensions: config.fuzz.dimensions,
    minimum: config.fuzz.minimum,
    maximum: config.fuzz.maximum,
    extremes: config.fuzz.extremes,
  });
  const requiredExtremeVectorDigests = Object.freeze([
    ...deterministicExtremeVectorDigests(config.fuzz),
  ]);
  return Object.freeze({
    originalTests: Object.freeze({
      kind: "original-tests" as const,
      structuralReceiptDigest: structural.receiptDigest,
      containerImageDigest: config.containerImageDigest,
    }),
    mutation: Object.freeze({
      kind: "mutation" as const,
      structuralReceiptDigest: structural.receiptDigest,
      inventoryDigest: digestValue(inventory),
      mutantIds: Object.freeze(
        inventory.map(({ mutantId }) => mutantId).sort(),
      ),
    }),
    property: Object.freeze({
      kind: "property" as const,
      structuralReceiptDigest: structural.receiptDigest,
      seedScheduleDigest,
      requiredRandomFuzzCaseCount: deterministicFuzzRandomCaseCount(
        config.fuzz,
      ),
      requiredExtremeVectorCount: requiredExtremeVectorDigests.length,
      requiredCaseCount: deterministicFuzzCaseCount(config.fuzz),
      requiredExtremeVectorDigests,
      extremeVectorInventoryDigest: digestValue(requiredExtremeVectorDigests),
      nodeIds,
      branchIds,
    }),
    coverage: Object.freeze({
      kind: "coverage" as const,
      structuralReceiptDigest: structural.receiptDigest,
      modifiedNodes: Object.freeze(
        structural.modifiedNodes.map(({ nodeId, lineIds, branchIds }) =>
          Object.freeze({ nodeId, lineIds, branchIds }),
        ),
      ),
      thresholds: config.coverage,
    }),
  });
}
