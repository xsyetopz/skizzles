import type { TypeScriptCompilerAuthority } from "../evidence/compiler.ts";
import type { RegisteredFormatterProfile } from "../evidence/contract.ts";
import type { TypeScriptSymbolIndexAuthorityPort } from "../typescript/symbols.ts";

export type TypeScriptAstLanguage = "javascript" | "tsx" | "typescript";

export interface SourceLanguageAdapter {
  readonly language: string;
  readonly parser: string;
  readonly parserVersion: string;
  supportsPath(path: string): boolean;
  supportsDeclarationKind(value: string): boolean;
  parse(input: unknown): Promise<unknown>;
  catalogDeclarations(document: unknown): unknown;
  digestSemantics(document: unknown): unknown;
  editDeclarations(input: unknown): Promise<unknown>;
  formatCandidate(input: unknown): Promise<unknown>;
  buildSymbolIndex(input: unknown): Promise<unknown>;
  verifyImport(index: unknown, query: unknown): unknown;
  validateCandidate(input: unknown): Promise<unknown>;
}

export interface TypeScriptAstLanguageAdapterConfig {
  readonly language: TypeScriptAstLanguage;
  readonly formatterProfiles: readonly RegisteredFormatterProfile[];
  readonly compilerAuthority: TypeScriptCompilerAuthority;
  readonly compilerProfile: Readonly<{
    profileId: string;
    toolId: "typescript";
    toolVersion: "7.0.2";
  }>;
  readonly symbolIndexAuthority: TypeScriptSymbolIndexAuthorityPort;
}

export type SourceLanguageAdapterCreationResult =
  | Readonly<{
      status: "created";
      adapter: SourceLanguageAdapter;
    }>
  | Readonly<{ status: "rejected"; code: "INVALID_LANGUAGE_ADAPTER" }>;
