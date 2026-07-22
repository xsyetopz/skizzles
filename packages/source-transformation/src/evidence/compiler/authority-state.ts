import type { Digest } from "../../digest.ts";
import type {
  CompilerEvidenceBindings,
  CompilerEvidenceReceipt,
  CompilerSymbolAuthorityPort,
} from "./contract.ts";

export interface TrustedCompilerState {
  readonly bindings: Readonly<{
    repositoryId: string;
    rootIdentity: string;
    treeDigest: Digest;
    configDigest: Digest;
    profileId: string;
    toolId: "typescript";
    toolVersion: "7.0.2";
  }>;
  readonly rootPath: string;
  readonly configPath: string;
  readonly configFileDigest: Digest;
  readonly symbols: CompilerSymbolAuthorityPort | undefined;
}

export interface ParsedCompilerInput {
  readonly bindings: CompilerEvidenceBindings;
  readonly targets: readonly ParsedCandidateOverlay[];
  readonly predecessor: CompilerEvidenceReceipt | null;
}

export interface ParsedCandidateOverlay {
  readonly path: string;
  readonly absolutePath: string;
  readonly candidateDigest: Digest;
  readonly semanticDigest: Digest;
  readonly candidateBytes: Uint8Array;
  readonly sourceText: string;
}

export interface CompilerRunResult {
  readonly allTargetsIncluded: boolean;
  readonly strict: boolean;
  readonly diagnostics: readonly import("./contract.ts").CompilerDiagnosticEvidence[];
  readonly outputDigest: Digest;
}
