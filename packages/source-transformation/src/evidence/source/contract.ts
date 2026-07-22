export type SourceEvidenceLanguage = string;

export interface SourceCaptureAuthorityPort {
  readonly capture: (input: unknown) => unknown | Promise<unknown>;
}

export interface TemplateAuthorityPort {
  readonly materialize: (input: unknown) => unknown | Promise<unknown>;
}

export interface SourceCaptureReceipt {
  readonly receiptDigest: string;
  readonly requestDigest: string;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: string;
  readonly configDigest: string;
  readonly path: string;
  readonly language: SourceEvidenceLanguage;
  readonly baselineDigest: string;
}

export interface TemplateEvidenceReceipt {
  readonly receiptDigest: string;
  readonly captureReceiptDigest: string;
  readonly requestDigest: string;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: string;
  readonly configDigest: string;
  readonly path: string;
  readonly language: SourceEvidenceLanguage;
  readonly baselineDigest: string;
  readonly templateId: string;
  readonly templateDigest: string;
  readonly tool: string;
  readonly toolVersion: string;
  readonly contentDigest: string;
  readonly schemaDigest: string;
  readonly nodeSourceDigest: string;
}

export type SourceEvidenceFailureCode =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "UNSUPPORTED_LANGUAGE"
  | "SOURCE_CAPTURE_REJECTED"
  | "SOURCE_CAPTURE_STALE"
  | "TEMPLATE_REJECTED"
  | "TEMPLATE_STALE"
  | "FORGED_CAPTURE";

export type SourceCaptureResult =
  | { readonly status: "captured"; readonly receipt: SourceCaptureReceipt }
  | { readonly status: "rejected"; readonly code: SourceEvidenceFailureCode };

export type TemplateEvidenceResult =
  | {
      readonly status: "materialized";
      readonly receipt: TemplateEvidenceReceipt;
    }
  | { readonly status: "rejected"; readonly code: SourceEvidenceFailureCode };

export interface SourceEvidenceAuthority {
  readonly capture: (input: unknown) => Promise<SourceCaptureResult>;
  readonly materializeTemplate: (
    input: unknown,
  ) => Promise<TemplateEvidenceResult>;
  readonly recoverCapture: (input: unknown) => SourceCaptureRecoveryResult;
  readonly recoverTemplate: (input: unknown) => TemplateEvidenceRecoveryResult;
}

export type SourceCaptureRecoveryResult =
  | { readonly status: "recovered"; readonly baselineBytes: readonly number[] }
  | { readonly status: "rejected"; readonly code: "FORGED_CAPTURE" };

export type TemplateEvidenceRecoveryResult =
  | { readonly status: "recovered"; readonly nodeSource: string }
  | { readonly status: "rejected"; readonly code: "TEMPLATE_REJECTED" };

export type SourceEvidenceCreationResult =
  | { readonly status: "created"; readonly evidence: SourceEvidenceAuthority }
  | { readonly status: "rejected"; readonly code: "INVALID_CONFIG" };
