import type { Digest } from "../../digest.ts";

export interface CompilerEvidenceBindings {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: Digest;
  readonly configDigest: Digest;
  readonly targetPath: string;
  readonly candidateDigest: Digest;
  readonly semanticDigest: Digest;
  readonly profileId: string;
  readonly toolId: "typescript";
  readonly toolVersion: "7.0.2";
}

export interface CompilerCandidateOverlay {
  readonly path: string;
  readonly candidateDigest: Digest;
  readonly semanticDigest: Digest;
  readonly candidateBytes: readonly number[];
}

export interface CompilerEvidenceInput extends CompilerEvidenceBindings {
  readonly targets: readonly CompilerCandidateOverlay[];
}

export interface CompilerDiagnosticEvidence {
  readonly path: string;
  readonly code: string;
  readonly severity: "error" | "warning" | "suggestion" | "message";
  readonly start: number;
  readonly end: number;
  readonly messageDigest: Digest;
}

export interface CompilerEvidenceReceipt extends CompilerEvidenceBindings {
  readonly targets: readonly Readonly<{
    path: string;
    candidateDigest: Digest;
    semanticDigest: Digest;
  }>[];
  readonly strictFlags: Readonly<{
    strict: true;
    noImplicitAny: true;
    strictNullChecks: true;
    noUncheckedIndexedAccess: true;
    exactOptionalPropertyTypes: true;
    useUnknownInCatchVariables: true;
  }>;
  readonly compiler: Readonly<{
    passed: true;
    exitCode: 0;
    diagnostics: readonly CompilerDiagnosticEvidence[];
    outputDigest: Digest;
  }>;
  readonly symbolIndex: Readonly<{
    status: "passed" | "failed" | "missing";
    unresolved: readonly string[];
    outputDigest: Digest;
    discrepancy: boolean;
  }>;
  readonly receiptDigest: Digest;
}

export type CompilerEvidenceFailureCode =
  | "INVALID_COMPILER_EVIDENCE_INPUT"
  | "UNAUTHENTIC_COMPILER_AUTHORITY"
  | "STALE_COMPILER_BINDINGS"
  | "STALE_CANDIDATE"
  | "STRICT_FLAGS_REJECTED"
  | "COMPILER_AUTHORITY_REJECTED"
  | "COMPILER_REJECTED";

export type CompilerEvidenceResult =
  | Readonly<{ status: "accepted"; receipt: CompilerEvidenceReceipt }>
  | Readonly<{
      status: "rejected";
      code: CompilerEvidenceFailureCode;
      diagnostics?: readonly CompilerDiagnosticEvidence[];
    }>;

export interface CompilerSymbolAuthorityPort {
  readonly inspect: (input: unknown) => unknown | Promise<unknown>;
}

export interface TypeScriptCompilerAuthorityConfig {
  readonly repository: Readonly<{
    repositoryId: string;
    rootIdentity: string;
    treeDigest: Digest;
    configDigest: Digest;
    rootPath: string;
    configPath: string;
  }>;
  readonly profile: Readonly<{
    profileId: string;
    toolId: "typescript";
    toolVersion: "7.0.2";
  }>;
  readonly symbols?: CompilerSymbolAuthorityPort;
}

export interface TypeScriptCompilerAuthority {
  readonly kind: "typescript-7-compiler-authority";
}

export type TypeScriptCompilerAuthorityCreationResult =
  | Readonly<{
      status: "created";
      authority: TypeScriptCompilerAuthority;
    }>
  | Readonly<{ status: "rejected"; code: "INVALID_COMPILER_CONFIG" }>;
