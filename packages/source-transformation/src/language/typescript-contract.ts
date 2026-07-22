import type { Digest } from "../digest.ts";
import type {
  CompilerEvidenceInput,
  CompilerEvidenceResult,
} from "../evidence/compiler.ts";
import type {
  RegisteredFormatterProfile,
  TypeScriptFormatterResult,
} from "../evidence/contract.ts";
import type {
  DeclarationKind,
  ParsedTypeScriptSource,
  TypeScriptDeclaration,
  TypeScriptEditResult,
  TypeScriptNodeOperation,
} from "../typescript/contract.ts";
import type { TypeScriptParseResult } from "../typescript/parser.ts";
import type {
  ImportVerificationResult,
  LocalTypeScriptSymbolIndex,
  SymbolIndexBuildResult,
} from "../typescript/symbols.ts";
import type { TypeScriptAstLanguageAdapterConfig } from "./contract.ts";

export interface TypeScriptAstLanguageCapability {
  readonly language: TypeScriptAstLanguageAdapterConfig["language"];
  readonly parser: "typescript-ast";
  readonly parserVersion: "7.0.2";
  supportsPath(path: string): boolean;
  supportsDeclarationKind(value: string): value is DeclarationKind;
  parse(input: unknown): Promise<TypeScriptParseResult>;
  catalogDeclarations(
    document: TypeScriptAstDocument,
  ): readonly TypeScriptDeclaration[] | undefined;
  digestSemantics(document: TypeScriptAstDocument): Digest | undefined;
  editDeclarations(
    input: TypeScriptAstEditInput,
  ): Promise<TypeScriptEditResult>;
  formatCandidate(
    input: TypeScriptAstFormatInput,
  ): Promise<TypeScriptFormatterResult>;
  buildSymbolIndex(input: unknown): Promise<SymbolIndexBuildResult>;
  verifyImport(index: unknown, query: unknown): ImportVerificationResult;
  validateCandidate(
    input: TypeScriptAstCompilerInput,
  ): Promise<CompilerEvidenceResult>;
}

export type TypeScriptAstDocument = ParsedTypeScriptSource;
export type TypeScriptAstSymbolIndex = LocalTypeScriptSymbolIndex;

export interface TypeScriptAstEditInput {
  readonly parsed: TypeScriptAstDocument;
  readonly objective: "behavioral" | "format-only";
  readonly operations: readonly TypeScriptNodeOperation[];
}

export interface TypeScriptAstFormatInput {
  readonly candidate: TypeScriptAstDocument;
  readonly treeDigest: Digest;
  readonly profileId: string;
}

export type TypeScriptAstCompilerInput = Omit<
  CompilerEvidenceInput,
  "profileId" | "toolId" | "toolVersion"
>;

export interface SourceLanguageAdapterBindings
  extends Omit<TypeScriptAstLanguageAdapterConfig, "formatterProfiles"> {
  readonly adapter: TypeScriptAstLanguageCapability;
  readonly formatterProfiles: ReadonlyMap<string, RegisteredFormatterProfile>;
}
