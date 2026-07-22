import type { ConfigurationWriteReceipt } from "../../configuration/contracts.ts";
import type { AssuranceDigest } from "../../digest.ts";

export interface CandidateBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type CredentialFindingCode =
  | "FORBIDDEN_ENV_PATH"
  | "FORBIDDEN_CONFIG_PATH"
  | "CREDENTIAL_STRUCTURE"
  | "HIGH_ENTROPY_SECRET";

export interface CredentialFinding {
  readonly code: CredentialFindingCode;
  readonly path: string;
  readonly message: string;
  readonly evidenceDigest: AssuranceDigest;
}

export interface SecretScanInput {
  readonly candidates: readonly CandidateBytes[];
  readonly configurationPaths?: readonly string[];
  readonly authorizedConfigurationWrites?: readonly ConfigurationWriteReceipt[];
}

export interface SecretScanReceipt {
  readonly accepted: boolean;
  readonly candidateDigest: AssuranceDigest;
  readonly findings: readonly CredentialFinding[];
  readonly scannedPaths: readonly string[];
  readonly receiptDigest: AssuranceDigest;
}

export type SecretScanResult =
  | { readonly ok: true; readonly receipt: SecretScanReceipt }
  | { readonly ok: false; readonly receipt: SecretScanReceipt };

export interface SecretScanner {
  readonly scan: (input: SecretScanInput) => SecretScanResult;
}
