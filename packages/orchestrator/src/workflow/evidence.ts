import { type Digest, digestBytes } from "../digest.ts";
import type {
  WorkflowVerificationEvidence,
  WorkflowVerificationMaterial,
} from "./verification/contract.ts";
import type { WorkflowTaskVerificationReceipts } from "./verification/task-contract.ts";

const maximumEvidenceBytes = 1_048_576;

export interface WorkflowEngineeringEvidence {
  readonly evidenceDigest: Digest;
  readonly evidenceBytes: readonly number[];
}

export interface WorkflowEngineeringEvidenceDraft {
  readonly schema: "skizzles.orchestrator/workflow-evidence-draft";
  readonly preGateDigest: Digest;
}

export interface WorkflowEvidenceCompletion {
  readonly verification: WorkflowVerificationEvidence;
  readonly taskVerification: WorkflowTaskVerificationReceipts;
}

export interface WorkflowEvidenceFinalization {
  readonly evidenceBytes: Uint8Array;
  readonly preview: object;
}

interface EvidenceAuthority {
  readonly bytes: Uint8Array;
  readonly revalidate: () => boolean | Promise<boolean>;
  readonly preview: object | null;
}

interface DraftAuthority {
  readonly preGateBytes: Uint8Array;
  readonly material: WorkflowVerificationMaterial;
  readonly revalidate: () => boolean | Promise<boolean>;
  readonly finalize: (
    completion: WorkflowEvidenceCompletion,
  ) => WorkflowEvidenceFinalization | Promise<WorkflowEvidenceFinalization>;
  consumed: boolean;
}

const authorities = new WeakMap<object, EvidenceAuthority>();
const drafts = new WeakMap<object, DraftAuthority>();

export function issueWorkflowEvidence(
  bytes: Uint8Array,
  revalidate: () => boolean | Promise<boolean>,
): WorkflowEngineeringEvidence | undefined {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumEvidenceBytes ||
    typeof revalidate !== "function"
  ) {
    return;
  }
  const snapshot = Uint8Array.from(bytes);
  const evidence = Object.freeze({
    evidenceDigest: digestBytes(snapshot),
    evidenceBytes: Object.freeze(Array.from(snapshot)),
  });
  authorities.set(evidence, { bytes: snapshot, revalidate, preview: null });
  return evidence;
}

export function issueWorkflowEvidenceDraft(
  input: Readonly<{
    preGateBytes: Uint8Array;
    material: WorkflowVerificationMaterial;
    revalidate: () => boolean | Promise<boolean>;
    finalize: (
      completion: WorkflowEvidenceCompletion,
    ) => WorkflowEvidenceFinalization | Promise<WorkflowEvidenceFinalization>;
  }>,
): WorkflowEngineeringEvidenceDraft | undefined {
  if (
    !(input.preGateBytes instanceof Uint8Array) ||
    input.preGateBytes.byteLength === 0 ||
    input.preGateBytes.byteLength > maximumEvidenceBytes ||
    typeof input.material !== "object" ||
    input.material === null ||
    typeof input.revalidate !== "function" ||
    typeof input.finalize !== "function"
  ) {
    return;
  }
  const preGateBytes = Uint8Array.from(input.preGateBytes);
  const draft: WorkflowEngineeringEvidenceDraft = Object.freeze({
    schema: "skizzles.orchestrator/workflow-evidence-draft" as const,
    preGateDigest: digestBytes(preGateBytes),
  });
  drafts.set(draft, {
    preGateBytes,
    material: input.material,
    revalidate: input.revalidate,
    finalize: input.finalize,
    consumed: false,
  });
  return draft;
}

export function isWorkflowEvidenceDraft(
  value: unknown,
): value is WorkflowEngineeringEvidenceDraft {
  return typeof value === "object" && value !== null && drafts.has(value);
}

export function workflowVerificationMaterial(
  draft: WorkflowEngineeringEvidenceDraft,
): WorkflowVerificationMaterial | undefined {
  const authority = drafts.get(draft);
  if (
    authority === undefined ||
    authority.consumed ||
    draft.preGateDigest !== digestBytes(authority.preGateBytes)
  ) {
    return;
  }
  return authority.material;
}

export async function revalidateWorkflowEvidenceDraft(
  draft: WorkflowEngineeringEvidenceDraft,
): Promise<boolean> {
  const authority = drafts.get(draft);
  if (
    authority === undefined ||
    authority.consumed ||
    draft.preGateDigest !== digestBytes(authority.preGateBytes)
  ) {
    return false;
  }
  try {
    return (await authority.revalidate()) === true;
  } catch {
    return false;
  }
}

export async function finalizeWorkflowEvidence(
  draft: WorkflowEngineeringEvidenceDraft,
  completion: WorkflowEvidenceCompletion,
  causalRevalidate: () => boolean | Promise<boolean>,
): Promise<WorkflowEngineeringEvidence | undefined> {
  const authority = drafts.get(draft);
  if (
    authority === undefined ||
    authority.consumed ||
    draft.preGateDigest !== digestBytes(authority.preGateBytes) ||
    typeof causalRevalidate !== "function"
  ) {
    return;
  }
  authority.consumed = true;
  let finalized: WorkflowEvidenceFinalization;
  try {
    finalized = await authority.finalize(completion);
  } catch {
    return;
  }
  if (
    !(finalized.evidenceBytes instanceof Uint8Array) ||
    finalized.evidenceBytes.byteLength === 0 ||
    finalized.evidenceBytes.byteLength > maximumEvidenceBytes ||
    typeof finalized.preview !== "object" ||
    finalized.preview === null ||
    !Object.isFrozen(finalized.preview)
  ) {
    return;
  }
  const bytes = Uint8Array.from(finalized.evidenceBytes);
  const evidence = Object.freeze({
    evidenceDigest: digestBytes(bytes),
    evidenceBytes: Object.freeze(Array.from(bytes)),
  });
  authorities.set(evidence, {
    bytes,
    preview: finalized.preview,
    revalidate: async () =>
      (await authority.revalidate()) === true &&
      (await causalRevalidate()) === true,
  });
  return evidence;
}

export function workflowEvidencePreview(
  evidence: WorkflowEngineeringEvidence,
): object | undefined {
  return authorities.get(evidence)?.preview ?? undefined;
}

export function isWorkflowEvidence(
  value: unknown,
): value is WorkflowEngineeringEvidence {
  return typeof value === "object" && value !== null && authorities.has(value);
}

export async function revalidateWorkflowEvidence(
  value: unknown,
): Promise<boolean> {
  if (!isWorkflowEvidence(value)) return false;
  const authority = authorities.get(value);
  if (authority === undefined) return false;
  if (
    value.evidenceDigest !== digestBytes(authority.bytes) ||
    value.evidenceBytes.length !== authority.bytes.length ||
    value.evidenceBytes.some((byte, index) => byte !== authority.bytes[index])
  ) {
    return false;
  }
  try {
    return (await authority.revalidate()) === true;
  } catch {
    return false;
  }
}
