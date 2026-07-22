import { digestValue } from "../../digest.ts";
import type {
  CausalWorkflow,
  WorkflowReview,
} from "../../workflow/contract.ts";
import {
  issueWorkflowEvidenceDraft,
  workflowEvidencePreview,
} from "../../workflow/evidence.ts";
import { verifyAssurance } from "../assurance/evidence.ts";
import { verifySecurityEvidence } from "../assurance/security.ts";
import type {
  EngineeringPrepareResult,
  EngineeringReview,
  EngineeringWorkflowConfig,
} from "../contract.ts";
import { negativeTestEvidenceMatches } from "../negative-evidence.ts";
import { isPhysicalIntegrationReceipt } from "../physical.ts";
import type { TaskReviewRecord } from "../reset/resources.ts";
import {
  createEvidenceBytes,
  createPreGateEvidenceBytes,
  createPreview,
  verifyPreparedSnapshot,
} from "../source/evidence.ts";
import type { PreparationState } from "../state.ts";

export async function prepareEngineeringPhase2(
  input: Readonly<{
    state: PreparationState;
    config: EngineeringWorkflowConfig;
    causal: CausalWorkflow;
    trackReview: (record: TaskReviewRecord) => void;
    trackPreReviewOutcome: (
      taskEpochDigest: PreparationState["taskEpochDigest"],
      result:
        | Awaited<ReturnType<CausalWorkflow["prepare"]>>
        | Awaited<ReturnType<CausalWorkflow["reject"]>>,
    ) => void;
  }>,
): Promise<EngineeringPrepareResult> {
  const { state } = input;
  if (state.prepared === null) {
    return fail(input.config, state, "SOURCE_ENGINEERING_REJECTED");
  }
  const prepared = state.prepared;
  if (state.assurance === null) {
    return fail(input.config, state, "CHANGE_ASSURANCE_REJECTED");
  }
  const assurance = state.assurance;
  if (state.security === null) {
    return fail(input.config, state, "SECURITY_REVIEW_REJECTED");
  }
  const security = state.security;
  const material = input.config.causal.verificationAuthority.issue({
    source: Object.freeze({
      authority: input.config.sourceEngineering,
      artifacts: prepared.artifactReferences,
      receipt: prepared.receiptReference,
      summary: Object.freeze({
        requestDigest: prepared.receipt.requestDigest,
        candidateDigest: prepared.receipt.candidateDigest,
        provenanceDigest: prepared.receipt.provenanceDigest,
        validationDigest: prepared.receipt.validationDigest,
        compilerReceiptDigest: prepared.receipt.compilerReceipt.receiptDigest,
        candidateManifestDigest: prepared.receipt.candidateManifestDigest,
        structuralReceipt: prepared.receipt.structuralReceipt,
      }),
    }),
    changeAssurance: Object.freeze({
      authority: input.config.changeAssurance,
      assessment: assurance.input,
      receipt: assurance.receipt,
      linter: input.config.securityPolicyLinter,
      lintReceipt: security.lintReceipt,
      reviewer: input.config.independentSecurityReview,
      reviewReceipt: security.reviewReceipt,
    }),
    physical: physicalEvidence(state, prepared.receipt.candidateDigest),
  });
  if (material === undefined) {
    return fail(input.config, state, "ENGINEERING_EVIDENCE_REJECTED");
  }
  const preGateBytes = createPreGateEvidenceBytes({
    contextReceiptDigest: state.context.receipt.receiptDigest,
    baselineDigest: state.baseline.baselineDigest,
    sourceReceipt: prepared.receipt,
    assuranceReceiptDigest: assurance.receipt.receiptDigest,
    lintReceiptDigest: security.lintReceipt.receiptDigest,
    reviewReceiptDigest: security.reviewReceipt.receiptDigest,
    physicalReceiptDigests: state.integrations.map(
      ({ receiptDigest }) => receiptDigest,
    ),
  });
  if (preGateBytes === undefined) {
    return fail(input.config, state, "ENGINEERING_EVIDENCE_REJECTED");
  }
  let finalizedPreview: EngineeringReview["preview"] | null = null;
  const evidenceDraft = issueWorkflowEvidenceDraft({
    preGateBytes,
    material,
    revalidate: async () =>
      verifyPreparedSnapshot(prepared) &&
      verifyAssurance(input.config.changeAssurance, assurance) &&
      verifySecurityEvidence(
        input.config.securityPolicyLinter,
        input.config.independentSecurityReview,
        assurance,
        security,
      ) &&
      (state.integrations.length === 0 ||
        state.integrations.every(isPhysicalIntegrationReceipt)),
    finalize: (completion) => {
      const preview = createPreview(
        prepared.receipt,
        assurance.receipt,
        state.integrations,
        security,
        completion,
      );
      const evidenceBytes = createEvidenceBytes({
        contextReceiptDigest: state.context.receipt.receiptDigest,
        baselineDigest: state.baseline.baselineDigest,
        preview,
        sourceReceipt: prepared.receipt,
        validationProfile: Object.freeze({
          id: state.input.profile.id,
          commandProfileIds: state.input.profile.commandProfileIds,
          negativeTestCommands: state.input.profile.negativeTestCommands,
        }),
      });
      if (evidenceBytes === undefined) {
        throw new Error("final workflow evidence rejected");
      }
      finalizedPreview = preview;
      return Object.freeze({ evidenceBytes, preview });
    },
  });
  if (evidenceDraft === undefined) {
    return fail(input.config, state, "ENGINEERING_EVIDENCE_REJECTED");
  }
  const result = await input.causal.prepare({
    request: state.input.request,
    repository: state.input.repository,
    targets: prepared.artifacts.map((artifact, index) => ({
      path: artifact.path,
      operation: "write",
      candidateBytes: prepared.candidateBytes[index],
    })),
    discoveryRoot: input.config.discoveryRoot,
    profileIds: Object.freeze([
      ...state.input.profile.commandProfileIds,
      ...state.input.profile.negativeTestCommands.map(
        ({ profileId }) => profileId,
      ),
    ]),
    taskEpochDigest: state.taskEpochDigest,
    baseline: state.baseline,
    engineeringEvidenceDraft: evidenceDraft,
  });
  if (result.status !== "awaiting-approval") {
    input.trackPreReviewOutcome(state.taskEpochDigest, result);
    return result;
  }
  if (
    finalizedPreview === null ||
    workflowEvidencePreview(result.review.engineeringEvidence) !==
      finalizedPreview ||
    !negativeTestEvidenceMatches(state, result.review)
  ) {
    return await rejectPreparedReview(
      input.causal,
      result.review,
      state.taskEpochDigest,
      input.trackPreReviewOutcome,
    );
  }
  const review: EngineeringReview = Object.freeze({
    ...result.review,
    preview: finalizedPreview,
  });
  input.trackReview({
    phase2: result.review,
    taskEpochDigest: state.taskEpochDigest,
    review,
  });
  return { status: "awaiting-approval", review };
}

function physicalEvidence(
  state: PreparationState,
  candidateDigest: `sha256:${string}`,
) {
  if (state.integrations.length === 0) {
    return Object.freeze({
      mode: "not-applicable" as const,
      declarationDigests: Object.freeze([]) as readonly [],
    });
  }
  return Object.freeze({
    mode: "attested" as const,
    candidateDigest,
    isolationDigest: digestValue(
      state.integrations.map((receipt) =>
        Object.freeze({
          receiptDigest: receipt.receiptDigest,
          manifestDigest: receipt.manifestDigest,
          probeDigest: receipt.probe.profileDigest,
        }),
      ),
    ),
    declarationDigests: Object.freeze(
      state.integrations.map(({ declarationDigest }) => declarationDigest),
    ),
    receiptDigests: Object.freeze(
      state.integrations.map(({ receiptDigest }) => receiptDigest),
    ),
    verify: () =>
      state.integrations.every(
        (receipt) =>
          isPhysicalIntegrationReceipt(receipt) &&
          receipt.bindings.requestDigest === state.input.request.intentDigest &&
          receipt.bindings.repositoryId ===
            state.input.repository.repositoryId &&
          receipt.bindings.treeDigest === state.input.repository.treeDigest &&
          receipt.bindings.baselineDigest === state.baseline.baselineDigest &&
          receipt.bindings.candidateDigest === candidateDigest,
      ),
  });
}

async function rejectPreparedReview(
  causal: CausalWorkflow,
  review: WorkflowReview,
  taskEpochDigest: PreparationState["taskEpochDigest"],
  trackPreReviewOutcome: (
    taskEpochDigest: PreparationState["taskEpochDigest"],
    result: Awaited<ReturnType<CausalWorkflow["reject"]>>,
  ) => void,
): Promise<EngineeringPrepareResult> {
  const cleanup = await causal.reject({ review });
  trackPreReviewOutcome(taskEpochDigest, cleanup);
  if (cleanup.status === "cleanup-pending") return cleanup;
  return {
    status: "rejected",
    code: "ENGINEERING_EVIDENCE_REJECTED",
    cleanup: cleanup.cleanup,
  };
}

function fail(
  config: EngineeringWorkflowConfig,
  state: PreparationState,
  code: Extract<
    EngineeringPrepareResult,
    { readonly status: "rejected" }
  >["code"],
): EngineeringPrepareResult {
  config.causal.orchestrator.releaseTargetBaseline(state.baseline);
  return { status: "rejected", code, cleanup: null };
}
