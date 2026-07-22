import type { Digest } from "../digest.ts";
import type { ParsedTypeScriptSource } from "../typescript/contract.ts";

export type FormatterPass = 1 | 2;

export interface FormatterPassRequest {
  readonly pass: FormatterPass;
  readonly profileId: string;
  readonly path: string;
  readonly treeDigest: Digest;
  readonly configDigest: Digest;
  readonly tool: string;
  readonly version: string;
  readonly candidateDigest: Digest;
  readonly inputDigest: Digest;
  readonly sourceText: string;
}

export interface FormatterPassResult {
  readonly pass: FormatterPass;
  readonly profileId: string;
  readonly path: string;
  readonly treeDigest: Digest;
  readonly configDigest: Digest;
  readonly tool: string;
  readonly version: string;
  readonly candidateDigest: Digest;
  readonly inputDigest: Digest;
  readonly formattedText: string;
}

export interface FormatterAuthorityPort {
  readonly format: (
    request: Readonly<FormatterPassRequest>,
  ) => unknown | Promise<unknown>;
}

export interface FormatterProfileRegistration {
  readonly profileId: string;
  readonly language: string;
  readonly tool: string;
  readonly version: string;
  readonly configDigest: Digest;
  readonly authority: FormatterAuthorityPort;
}

export interface RegisteredFormatterProfile {
  readonly profileId: string;
  readonly language: string;
  readonly tool: string;
  readonly version: string;
  readonly configDigest: Digest;
}

export type FormatterProfileRegistrationResult =
  | Readonly<{
      status: "registered";
      profile: RegisteredFormatterProfile;
    }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_FORMATTER_PROFILE";
    }>;

export interface TypeScriptFormatterInput {
  readonly candidate: ParsedTypeScriptSource;
  readonly treeDigest: Digest;
  readonly profile: RegisteredFormatterProfile;
}

export interface FormatterProvenanceReceipt {
  readonly path: string;
  readonly profileId: string;
  readonly tool: string;
  readonly version: string;
  readonly treeDigest: Digest;
  readonly configDigest: Digest;
  readonly candidateDigest: Digest;
  readonly candidateSemanticDigest: Digest;
  readonly pass1Digest: Digest;
  readonly pass2Digest: Digest;
  readonly formattedDigest: Digest;
  readonly formattedSemanticDigest: Digest;
  readonly provenanceDigest: Digest;
  readonly formattedBytes: readonly number[];
}

export type TypeScriptFormatterResult =
  | Readonly<{
      status: "formatted";
      receipt: FormatterProvenanceReceipt;
    }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_FORMATTER_INPUT"
        | "UNREGISTERED_FORMATTER_PROFILE"
        | "FORMATTER_REJECTED"
        | "FORMATTER_RESULT_INVALID"
        | "FORMATTER_BINDING_MISMATCH"
        | "FORMATTER_SYNTAX_REJECTED"
        | "FORMATTER_SEMANTIC_DRIFT"
        | "FORMATTER_NOT_IDEMPOTENT";
    }>;
