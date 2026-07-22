import { captureCompilerEvidence } from "../evidence/compiler.ts";
import { formatTypeScriptCandidate } from "../evidence/formatter.ts";
import {
  editTypeScriptDeclarations,
  listTypeScriptDeclarations,
  semanticDigest,
} from "../typescript/editor.ts";
import { parseTypeScriptSource } from "../typescript/parser.ts";
import {
  buildLocalTypeScriptSymbolIndex,
  verifyImport,
} from "../typescript/symbols.ts";
import type {
  SourceLanguageAdapter,
  TypeScriptAstLanguage,
} from "./contract.ts";
import type {
  SourceLanguageAdapterBindings,
  TypeScriptAstCompilerInput,
  TypeScriptAstDocument,
  TypeScriptAstEditInput,
  TypeScriptAstFormatInput,
  TypeScriptAstLanguageCapability,
} from "./typescript-contract.ts";

type ResolveBindings = (
  adapter: SourceLanguageAdapter,
) => SourceLanguageAdapterBindings | undefined;

export function createTypeScriptLanguageCapability(
  resolve: ResolveBindings,
): Omit<
  TypeScriptAstLanguageCapability,
  "language" | "parser" | "parserVersion"
> {
  return {
    supportsPath(this: SourceLanguageAdapter, path: string): boolean {
      const state = resolve(this);
      return state !== undefined && supportsLanguagePath(state.language, path);
    },
    supportsDeclarationKind(
      this: SourceLanguageAdapter,
      value: string,
    ): value is import("../typescript/contract.ts").DeclarationKind {
      const state = resolve(this);
      return (
        state !== undefined &&
        supportsLanguageDeclarationKind(state.language, value)
      );
    },
    async parse(this: SourceLanguageAdapter, input: unknown) {
      const state = resolve(this);
      const path = targetPathOf(input);
      if (
        state === undefined ||
        path === undefined ||
        !supportsLanguagePath(state.language, path)
      ) {
        return rejectedParse();
      }
      return await parseTypeScriptSource(input);
    },
    catalogDeclarations(
      this: SourceLanguageAdapter,
      document: TypeScriptAstDocument,
    ) {
      const state = resolve(this);
      if (
        state === undefined ||
        !supportsLanguagePath(state.language, document.path)
      ) {
        return;
      }
      try {
        return listTypeScriptDeclarations(document);
      } catch {}
      return;
    },
    digestSemantics(
      this: SourceLanguageAdapter,
      document: TypeScriptAstDocument,
    ) {
      const state = resolve(this);
      if (
        state === undefined ||
        !supportsLanguagePath(state.language, document.path)
      ) {
        return;
      }
      try {
        return semanticDigest(document.sourceFile);
      } catch {}
      return;
    },
    async editDeclarations(
      this: SourceLanguageAdapter,
      input: TypeScriptAstEditInput,
    ) {
      const state = resolve(this);
      if (
        state === undefined ||
        !supportsLanguagePath(state.language, input.parsed.path)
      ) {
        return rejectedEdit();
      }
      return await editTypeScriptDeclarations({
        parsed: input.parsed,
        objective: input.objective,
        operations: input.operations,
        parseCandidate: async (sourceText) => {
          const result = await parseTypeScriptSource({
            targetPath: input.parsed.path,
            sourceText,
          });
          if (result.status !== "parsed") throw new Error(result.code);
          return result.parsed;
        },
      });
    },
    async formatCandidate(
      this: SourceLanguageAdapter,
      input: TypeScriptAstFormatInput,
    ) {
      const state = resolve(this);
      const profile = state?.formatterProfiles.get(input.profileId);
      if (
        state === undefined ||
        profile === undefined ||
        !supportsLanguagePath(state.language, input.candidate.path)
      ) {
        return rejectedFormatter();
      }
      return await formatTypeScriptCandidate({
        candidate: input.candidate,
        treeDigest: input.treeDigest,
        profile,
      });
    },
    async buildSymbolIndex(this: SourceLanguageAdapter, input: unknown) {
      const state = resolve(this);
      if (state === undefined) return rejectedIndex();
      const result = await buildLocalTypeScriptSymbolIndex(
        state.symbolIndexAuthority,
        input,
      );
      if (
        result.status === "indexed" &&
        result.index.sourcePaths.some(
          (path) => !supportsLanguagePath(state.language, path),
        )
      ) {
        return rejectedIndexDocument();
      }
      return result;
    },
    verifyImport(this: SourceLanguageAdapter, index: unknown, query: unknown) {
      const state = resolve(this);
      if (state === undefined) return rejectedImport();
      const fromPath = importSourcePathOf(query);
      if (
        fromPath === undefined ||
        !supportsLanguagePath(state.language, fromPath)
      ) {
        return rejectedImportQuery();
      }
      return verifyImport(index, query);
    },
    async validateCandidate(
      this: SourceLanguageAdapter,
      input: TypeScriptAstCompilerInput,
    ) {
      const state = resolve(this);
      if (
        state === undefined ||
        !supportsLanguagePath(state.language, input.targetPath) ||
        input.targets.some(
          ({ path }) => !supportsLanguagePath(state.language, path),
        )
      ) {
        return rejectedCompiler();
      }
      return await captureCompilerEvidence(state.compilerAuthority, {
        ...input,
        profileId: state.compilerProfile.profileId,
        toolId: state.compilerProfile.toolId,
        toolVersion: state.compilerProfile.toolVersion,
      });
    },
  };
}

export function supportsLanguagePath(
  language: TypeScriptAstLanguage,
  path: string,
): boolean {
  if (language === "typescript") return /\.(?:cts|mts|ts)$/u.test(path);
  if (language === "tsx") return path.endsWith(".tsx");
  return /\.(?:cjs|js|jsx|mjs)$/u.test(path);
}

export function supportsLanguageDeclarationKind(
  language: TypeScriptAstLanguage,
  value: string,
): value is import("../typescript/contract.ts").DeclarationKind {
  if (value === "class" || value === "function") return true;
  return (
    language !== "javascript" &&
    (value === "enum" || value === "interface" || value === "type")
  );
}

function targetPathOf(value: unknown): string | undefined {
  return dataProperty(value, "targetPath");
}

function importSourcePathOf(value: unknown): string | undefined {
  return dataProperty(value, "fromPath");
}

function dataProperty(value: unknown, key: string): string | undefined {
  try {
    if (typeof value !== "object" || value === null) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {}
  return;
}

function rejectedParse() {
  return Object.freeze({
    status: "rejected" as const,
    code: "INVALID_PARSE_INPUT" as const,
    diagnostics: Object.freeze([]),
  });
}

function rejectedEdit() {
  return Object.freeze({
    status: "rejected" as const,
    code: "INVALID_EDIT" as const,
  });
}

function rejectedFormatter() {
  return Object.freeze({
    status: "rejected" as const,
    code: "INVALID_FORMATTER_INPUT" as const,
  });
}

function rejectedIndex() {
  return Object.freeze({
    status: "rejected" as const,
    code: "INVALID_INDEX_AUTHORITY" as const,
  });
}

function rejectedIndexDocument() {
  return Object.freeze({
    status: "rejected" as const,
    code: "INDEX_DOCUMENT_INVALID" as const,
  });
}

function rejectedImport() {
  return Object.freeze({
    status: "rejected" as const,
    code: "INVALID_INDEX" as const,
  });
}

function rejectedImportQuery() {
  return Object.freeze({
    status: "rejected" as const,
    code: "INVALID_IMPORT_QUERY" as const,
  });
}

function rejectedCompiler() {
  return Object.freeze({
    status: "rejected" as const,
    code: "INVALID_COMPILER_EVIDENCE_INPUT" as const,
  });
}
