import {
  type EvidenceReference,
  type RunStatus,
  sha256Digest,
} from "./run-status.ts";

function verifyEvidence(
  status: RunStatus,
  evidence: EvidenceReference,
  content: Uint8Array,
): boolean {
  const terminal = status.lifecycle.state !== "running";
  return (
    content.length >= evidence.storedBytes &&
    (!terminal || content.length === evidence.storedBytes) &&
    content.length <= status.retention.maximumArtifactBytes &&
    sha256Digest(content.subarray(0, evidence.storedBytes)) === evidence.sha256
  );
}

export function verifyRunEvidence(
  status: RunStatus,
  stdout: Uint8Array,
  stderr: Uint8Array,
): boolean {
  return (
    verifyEvidence(status, status.evidence.stdout, stdout) &&
    verifyEvidence(status, status.evidence.stderr, stderr)
  );
}
