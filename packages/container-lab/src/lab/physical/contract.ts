import type { Endpoint } from "../../state/lab/contract.ts";

export const MAXIMUM_PROBE_OUTPUT_BYTES = 1_048_576;

export interface PhysicalConnection {
  readonly name: string;
  readonly service: string;
  readonly target: number;
  readonly scheme: string;
}

export interface PhysicalProbe {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileDigest: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
}

export interface PhysicalProbeProfile {
  readonly id: string;
  readonly version: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
}

export interface PhysicalIntegrationBindings {
  readonly requestDigest: string;
  readonly repositoryId: string;
  readonly treeDigest: string;
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly provenanceDigest: string;
}

export interface PhysicalCandidateTarget {
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly bytes: readonly number[];
}

export interface PhysicalCandidateMeasurement {
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
}

export interface PhysicalCandidateEvidence {
  readonly targetSetDigest: string;
  readonly candidateDigest: string;
  readonly workspaceIdentityDigest: string;
  readonly provenanceMeasurementDigest: string;
  readonly targets: readonly PhysicalCandidateMeasurement[];
}

export interface PhysicalIntegrationDeclaration {
  readonly version: 1;
  readonly kind: "physical-integration";
  readonly declarationDigest: string;
  readonly owner: string;
  readonly ownerKey: string;
  readonly labId: string;
  readonly composeProject: string;
  readonly sourceRepositoryIdentity: string;
  readonly labUpdatedAt: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly connections: readonly PhysicalConnection[];
  readonly probe: PhysicalProbe;
}

export interface PhysicalProbeEvidence {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileDigest: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environmentNames: readonly string[];
  readonly exitCode: number;
  readonly stdoutBytes: number;
  readonly stdoutDigest: string;
  readonly stderrBytes: number;
  readonly stderrDigest: string;
  readonly complete: true;
}

export interface PhysicalCleanupProof {
  readonly destroyReported: true;
  readonly labAbsent: true;
  readonly terminal: true;
}

export interface PhysicalIntegrationReceipt {
  readonly version: 1;
  readonly receiptDigest: string;
  readonly declarationDigest: string;
  readonly bindings: PhysicalIntegrationBindings;
  readonly owner: string;
  readonly ownerKey: string;
  readonly labId: string;
  readonly composeProject: string;
  readonly sourceRepositoryIdentity: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly readyState: "ready";
  readonly connections: readonly PhysicalConnection[];
  readonly endpoints: readonly Endpoint[];
  readonly candidate: PhysicalCandidateEvidence;
  readonly probe: PhysicalProbeEvidence;
  readonly cleanup: PhysicalCleanupProof;
}

export type PhysicalIntegrationRejectionCode =
  | "INVALID_INPUT"
  | "MOCKED_EVIDENCE_REJECTED"
  | "DECLARATION_REJECTED"
  | "DECLARATION_STALE"
  | "MANIFEST_MISMATCH"
  | "LAB_NOT_READY"
  | "ENDPOINT_MISMATCH"
  | "CANDIDATE_REJECTED"
  | "CANDIDATE_DRIFTED"
  | "PROBE_REJECTED"
  | "CLEANUP_REJECTED";

export interface PhysicalIntegrationRejection {
  readonly status: "rejected";
  readonly code: PhysicalIntegrationRejectionCode;
}

export type PhysicalIntegrationDeclarationResult =
  | Readonly<{
      status: "declared";
      declaration: PhysicalIntegrationDeclaration;
    }>
  | PhysicalIntegrationRejection;

export type PhysicalIntegrationReceiptResult =
  | Readonly<{
      status: "accepted";
      receipt: PhysicalIntegrationReceipt;
    }>
  | PhysicalIntegrationRejection;

export interface PhysicalIntegrationAuthority {
  readonly attest: (
    input: unknown,
  ) => Promise<PhysicalIntegrationReceiptResult>;
}

export interface PhysicalIntegrationController
  extends PhysicalIntegrationAuthority {
  readonly declare: (
    input: unknown,
  ) => Promise<PhysicalIntegrationDeclarationResult>;
}
