import { digestValue } from "../../digest.ts";
import type {
  EngineeringPreview,
  EngineeringWorkflowConfig,
} from "../contract.ts";
import type { PhysicalIntegrationReceipt } from "../physical.ts";
import {
  readSourceArtifact,
  type SourceArtifact,
  type SourceReceipt,
  startSourceEngineering,
  verifySourceEngineering,
} from "./adapter.ts";

export interface PreparedBatch {
  readonly artifacts: readonly SourceArtifact[];
  readonly artifactReferences: readonly object[];
  readonly receipt: SourceReceipt;
  readonly receiptReference: object;
  readonly candidateBytes: readonly (readonly number[])[];
}

export function prepareBatch(
  result: Extract<
    Awaited<ReturnType<typeof startSourceEngineering>>,
    { status: "prepared" }
  >,
  expectedPaths: readonly string[],
): PreparedBatch | undefined {
  const artifacts = [...result.artifacts].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (
    artifacts.length !== expectedPaths.length ||
    artifacts.some((artifact, index) => artifact.path !== expectedPaths[index])
  ) {
    return;
  }
  const bytes = artifacts.map(readSourceArtifact);
  if (bytes.some((candidate) => candidate === undefined)) return;
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    artifactReferences: result.artifactReferences,
    receipt: result.receipt,
    receiptReference: result.receiptReference,
    candidateBytes: Object.freeze(
      bytes.filter(
        (candidate): candidate is readonly number[] => candidate !== undefined,
      ),
    ),
  });
}

export function createPreview(
  receipt: SourceReceipt,
  integrations: readonly PhysicalIntegrationReceipt[],
): EngineeringPreview {
  const sourceEvidence = sourceEvidenceSummary(receipt);
  return Object.freeze({
    evidenceDigest: digestValue({ sourceEvidence, integrations }),
    candidateDigest: receipt.candidateDigest,
    provenanceDigest: receipt.provenanceDigest,
    validationDigest: receipt.validationDigest,
    observedNegativeTests: receipt.observedNegativeTests,
    targets: Object.freeze(
      receipt.targetReceipts.map((target) =>
        Object.freeze({
          path: target.path,
          candidateDigest: target.candidateDigest,
          baselineSemanticDigest: target.baselineSemanticDigest,
          candidateSemanticDigest: target.candidateSemanticDigest,
          provenanceDigest: receipt.provenanceDigest,
          validationDigest: receipt.validationDigest,
        }),
      ),
    ),
    integrations,
  });
}

export function createEvidenceBytes(input: {
  readonly contextReceiptDigest: string;
  readonly baselineDigest: string;
  readonly preview: EngineeringPreview;
  readonly sourceReceipt: SourceReceipt;
  readonly validationProfile: {
    readonly id: string;
    readonly commandProfileIds: readonly string[];
    readonly negativeTestCommands: readonly {
      readonly profileId: string;
      readonly testPaths: readonly string[];
    }[];
  };
}): Uint8Array | undefined {
  try {
    return new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        contextReceiptDigest: input.contextReceiptDigest,
        baselineDigest: input.baselineDigest,
        preview: input.preview,
        sourceReceipt: sourceEvidenceSummary(input.sourceReceipt),
        validationProfile: input.validationProfile,
      }),
    );
  } catch {
    return;
  }
}

function sourceEvidenceSummary(receipt: SourceReceipt) {
  return Object.freeze({
    requestDigest: receipt.requestDigest,
    contextDigest: receipt.contextDigest,
    contextReceiptDigest: receipt.contextReceiptDigest,
    baselineDigest: receipt.baselineDigest,
    candidateDigest: receipt.candidateDigest,
    provenanceDigest: receipt.provenanceDigest,
    validationDigest: receipt.validationDigest,
    targets: Object.freeze(
      receipt.targetReceipts.map((target) =>
        Object.freeze({
          path: target.path,
          baselineDigest: target.baselineDigest,
          candidateDigest: target.candidateDigest,
          baselineSemanticDigest: target.baselineSemanticDigest,
          candidateSemanticDigest: target.candidateSemanticDigest,
        }),
      ),
    ),
  });
}

export async function verifyPrepared(
  config: EngineeringWorkflowConfig,
  prepared: PreparedBatch,
): Promise<boolean> {
  if (
    prepared.artifacts.some(
      (artifact, index) =>
        !sameBytes(
          readSourceArtifact(artifact),
          prepared.candidateBytes[index],
        ),
    )
  ) {
    return false;
  }
  return await verifySourceEngineering(
    config.sourceEngineering,
    prepared.artifactReferences,
    prepared.receiptReference,
    prepared.receipt,
  );
}

function sameBytes(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}
