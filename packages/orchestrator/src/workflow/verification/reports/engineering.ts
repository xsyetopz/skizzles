import type { VerificationAuthorityRequest } from "@skizzles/acceptance";
import { isStructuralEvidenceReceipt } from "@skizzles/source-transformation";
import { digestValue } from "../../../digest.ts";
import type { WorkflowVerificationMaterialInput } from "../contract.ts";

export type EngineeringMaterialResolver = (
  request: VerificationAuthorityRequest,
) => WorkflowVerificationMaterialInput | undefined;

export function sourceReport(
  request: VerificationAuthorityRequest,
  resolve: EngineeringMaterialResolver,
): unknown {
  const material = resolve(request);
  if (material === undefined) return;
  const source = material.source;
  if (!isStructuralEvidenceReceipt(source.summary.structuralReceipt)) {
    return;
  }
  const structural = source.summary.structuralReceipt;
  return Object.freeze({
    status: "valid" as const,
    bindingDigest: request.bindingDigest,
    evidenceDigest: digestValue({
      validationDigest: source.summary.validationDigest,
      structuralReceiptDigest: structural.receiptDigest,
      compilerReceiptDigest: source.summary.compilerReceiptDigest,
    }),
    candidateManifestDigest: source.summary.candidateManifestDigest,
    structuralReceiptDigest: structural.receiptDigest,
    compilerChainDigest: structural.compilerChain.receiptDigest,
    complexityEvidenceDigest: digestValue({
      policyDigest: structural.policy.policyDigest,
      baselineAggregateComplexity: structural.baselineAggregateComplexity,
      candidateAggregateComplexity: structural.candidateAggregateComplexity,
      nodes: structural.modifiedNodes.map(
        ({ nodeId, complexityReceiptDigest }) =>
          Object.freeze({ nodeId, complexityReceiptDigest }),
      ),
    }),
    modifiedNodes: Object.freeze(
      structural.modifiedNodes.map((node) =>
        Object.freeze({
          nodeId: node.nodeId,
          nodeDigest: node.nodeDigest,
          pathDigest: node.pathDigest,
          kind: node.kind,
          lineIds: node.lineIds,
          branchIds: node.branchIds,
          mutationSites: Object.freeze(
            node.mutationSites.map((site) =>
              Object.freeze({
                siteId: site.siteId,
                kind: site.kind,
                variants: Object.freeze(
                  site.variants.map(({ variantId }) =>
                    Object.freeze({ variantId }),
                  ),
                ),
              }),
            ),
          ),
          complexityDigest: node.complexityReceiptDigest,
        }),
      ),
    ),
  });
}

export function assuranceReport(
  request: VerificationAuthorityRequest,
  resolve: EngineeringMaterialResolver,
): unknown {
  const material = resolve(request);
  if (material === undefined) return;
  const evidence = material.changeAssurance;
  try {
    if (
      !(
        evidence.authority.verify(
          Object.freeze({
            assessment: evidence.assessment,
            receipt: evidence.receipt,
          }),
        ) &&
        evidence.linter.verify(
          Object.freeze({
            assessment: evidence.assessment,
            assuranceReceipt: evidence.receipt,
            receipt: evidence.lintReceipt,
          }),
        ) &&
        evidence.reviewer.verify(
          Object.freeze({
            assessment: evidence.assessment,
            assuranceReceipt: evidence.receipt,
            lintReceipt: evidence.lintReceipt,
            receipt: evidence.reviewReceipt,
          }),
        )
      )
    ) {
      return;
    }
  } catch {
    return;
  }
  return Object.freeze({
    status: "valid" as const,
    bindingDigest: request.bindingDigest,
    evidenceDigest: digestValue({
      assuranceReceiptDigest: evidence.receipt.receiptDigest,
      lintReceiptDigest: evidence.lintReceipt.receiptDigest,
      reviewReceiptDigest: evidence.reviewReceipt.receiptDigest,
    }),
    candidateDigest: request.bindings.candidateDigest,
    candidateManifestDigest: request.bindings.candidateManifestDigest,
  });
}

export async function physicalReport(
  request: VerificationAuthorityRequest,
  resolve: EngineeringMaterialResolver,
): Promise<unknown> {
  const material = resolve(request);
  if (material === undefined) return;
  const physical = material.physical;
  if (physical.mode === "not-applicable") {
    return Object.freeze({
      status: "valid" as const,
      bindingDigest: request.bindingDigest,
      evidenceDigest: digestValue({
        mode: physical.mode,
        taskId: request.bindings.taskId,
        taskEpochDigest: request.bindings.taskEpochDigest,
        requestDigest: request.bindings.requestDigest,
        candidateDigest: request.bindings.candidateDigest,
        declarationDigests: physical.declarationDigests,
      }),
      candidateDigest: request.bindings.candidateDigest,
      isolationDigest: digestValue({
        mode: physical.mode,
        declarations: physical.declarationDigests,
      }),
    });
  }
  if (
    physical.candidateDigest !== request.bindings.candidateDigest ||
    physical.declarationDigests.length === 0 ||
    physical.receiptDigests.length !== physical.declarationDigests.length
  ) {
    return;
  }
  try {
    if ((await physical.verify()) !== true) return;
  } catch {
    return;
  }
  return Object.freeze({
    status: "valid" as const,
    bindingDigest: request.bindingDigest,
    evidenceDigest: digestValue({
      mode: physical.mode,
      declarationDigests: physical.declarationDigests,
      receiptDigests: physical.receiptDigests,
    }),
    candidateDigest: physical.candidateDigest,
    isolationDigest: physical.isolationDigest,
  });
}
