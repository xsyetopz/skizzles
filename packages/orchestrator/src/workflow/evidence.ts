import { type Digest, digestBytes } from "../digest.ts";

const maximumEvidenceBytes = 1_048_576;

export interface WorkflowEngineeringEvidence {
  readonly evidenceDigest: Digest;
  readonly evidenceBytes: readonly number[];
}

interface EvidenceAuthority {
  readonly bytes: Uint8Array;
  readonly revalidate: () => boolean | Promise<boolean>;
}

const authorities = new WeakMap<object, EvidenceAuthority>();

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
  authorities.set(evidence, { bytes: snapshot, revalidate });
  return evidence;
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
