import type { Digest } from "../digest.ts";
import type { CompilerEvidenceReceipt } from "../evidence/compiler.ts";
import type { FormatterProvenanceReceipt } from "../evidence/contract.ts";
import type { TemplateEvidenceReceipt } from "../evidence/source.ts";

export interface SourceEngineeringContextTemplate {
  readonly templateId: string;
  readonly language: string;
  readonly schemaText: string;
  readonly schemaDigest: Digest;
  readonly tool: string;
  readonly version: string;
}

export interface SourceEngineeringContextDeclaration {
  readonly declarationKind: string;
  readonly name: string;
  readonly nodeDigest: Digest;
}

export interface SourceEngineeringContextTarget {
  readonly path: string;
  readonly baselineDigest: Digest;
  readonly baselineSemanticDigest: Digest;
  readonly declarations: readonly SourceEngineeringContextDeclaration[];
}

export interface SourceEngineeringContext {
  readonly contextDigest: Digest;
  readonly templates: readonly SourceEngineeringContextTemplate[];
  readonly targets: readonly SourceEngineeringContextTarget[];
}

export interface SourceEngineeringContextReceipt {
  readonly receiptDigest: Digest;
  readonly contextDigest: Digest;
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: Digest;
  readonly configDigest: Digest;
  readonly targetSetDigest: Digest;
}

export interface SourceEngineeringCursor {
  readonly cursorId: string;
  readonly requestDigest: Digest;
  readonly stateDigest: Digest;
  readonly candidateDigest: Digest;
  readonly step: number;
  readonly totalSteps: number;
}

export interface SourceEngineeringNextStep {
  readonly kind: "edit" | "format" | "validate";
  readonly ordinal: number;
  readonly operationIndex?: number;
}

export interface SourceEngineeringArtifact {
  readonly path: string;
  readonly baselineDigest: Digest;
  readonly baselineByteLength: number;
  readonly digest: Digest;
  readonly byteLength: number;
  readonly readBaselineBytes: () => Uint8Array;
  readonly readBytes: () => Uint8Array;
}

export interface SourceEngineeringTargetReceipt {
  readonly path: string;
  readonly baselineDigest: Digest;
  readonly candidateDigest: Digest;
  readonly baselineSemanticDigest: Digest;
  readonly candidateSemanticDigest: Digest;
  readonly changedDeclarations: readonly Digest[];
  readonly templateReceipts: readonly TemplateEvidenceReceipt[];
  readonly formatterReceipt: FormatterProvenanceReceipt;
}

export interface SourceEngineeringIndexReceipt {
  readonly status: "indexed";
  readonly language: string;
  readonly advisory: true;
  readonly indexDigest: Digest;
}

export interface SourceEngineeringCompilerReceipt {
  readonly receipts: readonly CompilerEvidenceReceipt[];
  readonly receiptDigest: Digest;
}

export interface SourceEngineeringPolicyReceipt {
  readonly findingCount: 0;
  readonly changeSetDigest: Digest;
  readonly observedNegativeTests: readonly Readonly<{
    productionPath: string;
    testPath: string;
    failureCodes: readonly string[];
  }>[];
  readonly faultEvidenceDigest: Digest;
  readonly literalRegistryDigest: Digest;
  readonly receiptDigest: Digest;
}

export interface SourceEngineeringTaskReceipt {
  readonly requestDigest: Digest;
  readonly contextDigest: Digest;
  readonly contextReceiptDigest: Digest;
  readonly baselineDigest: Digest;
  readonly candidateDigest: Digest;
  readonly targetReceipts: readonly SourceEngineeringTargetReceipt[];
  readonly indexReceipt: SourceEngineeringIndexReceipt;
  readonly compilerReceipt: SourceEngineeringCompilerReceipt;
  readonly policyReceipt: SourceEngineeringPolicyReceipt;
  readonly provenanceDigest: Digest;
  readonly validationDigest: Digest;
}

export type SourceEngineeringFailureCode =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "UNSUPPORTED_LANGUAGE"
  | "CONTEXT_REJECTED"
  | "CONTEXT_FORGED"
  | "CONTEXT_REPLAYED"
  | "CONTEXT_DRIFTED"
  | "CURSOR_FORGED"
  | "CURSOR_REPLAYED"
  | "EDIT_REJECTED"
  | "TEMPLATE_REJECTED"
  | "FORMATTER_REJECTED"
  | "POLICY_REJECTED"
  | "COMPILER_REJECTED"
  | "ARTIFACT_REJECTED"
  | "RECEIPT_FORGED"
  | "RECEIPT_REPLAYED";

export type SourceEngineeringDescribeResult =
  | Readonly<{
      status: "described";
      context: SourceEngineeringContext;
      receipt: SourceEngineeringContextReceipt;
    }>
  | Readonly<{ status: "rejected"; code: SourceEngineeringFailureCode }>;

export type SourceEngineeringStartResult =
  | Readonly<{
      status: "ready";
      cursor: SourceEngineeringCursor;
      next: SourceEngineeringNextStep;
    }>
  | Readonly<{ status: "rejected"; code: SourceEngineeringFailureCode }>;

export type SourceEngineeringAdvanceResult =
  | SourceEngineeringStartResult
  | Readonly<{
      status: "prepared";
      artifacts: readonly SourceEngineeringArtifact[];
      receipt: SourceEngineeringTaskReceipt;
    }>;

export type SourceEngineeringVerifyResult =
  | Readonly<{
      status: "valid";
      candidateDigest: Digest;
      provenanceDigest: Digest;
      validationDigest: Digest;
    }>
  | Readonly<{ status: "rejected"; code: SourceEngineeringFailureCode }>;

export interface SourceEngineering {
  readonly describe: (
    input: unknown,
  ) => Promise<SourceEngineeringDescribeResult>;
  readonly start: (input: unknown) => SourceEngineeringStartResult;
  readonly advance: (input: unknown) => Promise<SourceEngineeringAdvanceResult>;
  readonly verify: (input: unknown) => SourceEngineeringVerifyResult;
}

export type SourceEngineeringCreationResult =
  | Readonly<{ status: "created"; sourceEngineering: SourceEngineering }>
  | Readonly<{ status: "rejected"; code: "INVALID_CONFIG" }>;
