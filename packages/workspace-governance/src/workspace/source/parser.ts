// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteral,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { API, type Diagnostic } from "typescript/unstable/async";
import {
  scanTemporaryOwnership,
  type TemporaryOwnershipUse,
} from "./temporary.ts";

const SOURCE_DECODER = new TextDecoder();
const SHEBANG_LINE_TERMINATOR_PATTERN = /[\n\r\u2028\u2029]/u;

interface SourceDocument {
  path: string;
  source: Uint8Array;
  loader: "ts" | "tsx";
}

interface SourceDependencyResult {
  path: string;
  specifiers?: readonly string[];
  temporaryOwnership?: readonly TemporaryOwnershipUse[];
  error?: string;
}

interface StaticDependencyResult {
  path: string;
  specifiers?: readonly string[];
  temporaryOwnership?: readonly TemporaryOwnershipUse[];
  error?: string;
}

interface SourceDependencyBackend {
  parse: (
    paths: readonly string[],
  ) => Promise<readonly StaticDependencyResult[]>;
  close: () => Promise<void>;
}

type SourceDependencyBackendFactory = () => SourceDependencyBackend;
type CurrentSourceReader = (path: string) => Promise<Uint8Array>;

class TypeScriptSourceDependencyBackend implements SourceDependencyBackend {
  readonly #api = new API();
  #snapshot: Awaited<ReturnType<API["updateSnapshot"]>> | undefined;

  async parse(paths: readonly string[]): Promise<StaticDependencyResult[]> {
    if (this.#snapshot !== undefined) {
      throw new Error("TypeScript source parser session was already used");
    }
    this.#snapshot = await this.#api.updateSnapshot({ openFiles: [...paths] });
    const results: StaticDependencyResult[] = [];
    for (const path of paths) {
      const project = await this.#snapshot.getDefaultProjectForFile(path);
      if (project === undefined) {
        results.push({ path, error: "TypeScript did not open a project" });
        continue;
      }
      const diagnostics = await project.program.getSyntacticDiagnostics(path);
      if (diagnostics.length > 0) {
        results.push({ path, error: formatDiagnostics(diagnostics) });
        continue;
      }
      const sourceFile = await project.program.getSourceFile(path);
      if (sourceFile === undefined) {
        results.push({
          path,
          error: "TypeScript did not return a source file",
        });
        continue;
      }
      const temporaryOwnership = scanTemporaryOwnership(sourceFile);
      results.push({
        path,
        specifiers: scanStaticDependencies(sourceFile),
        ...(temporaryOwnership.length === 0 ? {} : { temporaryOwnership }),
      });
    }
    return results;
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    if (this.#snapshot !== undefined) {
      try {
        await this.#snapshot.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.#api.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new Error(
        `TypeScript source parser cleanup failed: ${errors.map(errorMessage).join("; ")}`,
      );
    }
  }
}

async function parseSourceDependencies(
  documents: readonly SourceDocument[],
  createBackend: SourceDependencyBackendFactory = () =>
    new TypeScriptSourceDependencyBackend(),
  readCurrentSource: CurrentSourceReader = readFile,
): Promise<SourceDependencyResult[]> {
  if (documents.length === 0) {
    return [];
  }
  let backend: SourceDependencyBackend | undefined;
  let staticResults: readonly StaticDependencyResult[] = [];
  const backendErrors: string[] = [];
  try {
    backend = createBackend();
    staticResults = await backend.parse(documents.map(({ path }) => path));
  } catch (error) {
    backendErrors.push(errorMessage(error));
  } finally {
    if (backend !== undefined) {
      try {
        await backend.close();
      } catch (error) {
        backendErrors.push(errorMessage(error));
      }
    }
  }
  if (backendErrors.length > 0) {
    const error = backendErrors.join("; ");
    return documents.map(({ path }) => ({ path, error }));
  }

  const staticByPath = new Map(
    staticResults.map((result) => [result.path, result]),
  );
  const sourceStates = await Promise.all(
    documents.map(async (document) => {
      try {
        const current = await readCurrentSource(document.path);
        return {
          path: document.path,
          error: equalBytes(document.source, current)
            ? undefined
            : "source changed during TypeScript parsing",
        };
      } catch {
        return {
          path: document.path,
          error: "source could not be reread after TypeScript parsing",
        };
      }
    }),
  );
  const sourceStateByPath = new Map(
    sourceStates.map((state) => [state.path, state]),
  );
  return documents.map((document) => {
    const sourceState = sourceStateByPath.get(document.path);
    if (sourceState?.error !== undefined) {
      return { path: document.path, error: sourceState.error };
    }
    const parsed = staticByPath.get(document.path);
    if (parsed === undefined) {
      return {
        path: document.path,
        error: "TypeScript source parser omitted the file",
      };
    }
    if (parsed.error !== undefined) {
      return { path: document.path, error: parsed.error };
    }
    try {
      const runtime = new Bun.Transpiler({ loader: document.loader })
        .scanImports(stripShebang(SOURCE_DECODER.decode(document.source)))
        .map(({ path }) => path);
      return {
        path: document.path,
        specifiers: [
          ...new Set([...runtime, ...(parsed.specifiers ?? [])]),
        ].sort((left, right) => left.localeCompare(right)),
        ...(parsed.temporaryOwnership === undefined
          ? {}
          : { temporaryOwnership: parsed.temporaryOwnership }),
      };
    } catch (error) {
      return { path: document.path, error: errorMessage(error) };
    }
  });
}

function scanStaticDependencies(sourceFile: SourceFile): string[] {
  const specifiers = new Set<string>();
  for (const reference of sourceFile.referencedFiles) {
    specifiers.add(
      normalizePathReference(sourceFile.fileName, reference.fileName),
    );
  }
  for (const reference of sourceFile.typeReferenceDirectives) {
    specifiers.add(reference.fileName);
  }
  // `lib` directives select compiler-owned standard library declarations;
  // unlike path and types directives, they do not create workspace or package
  // dependency edges and are intentionally excluded.
  const visit = (node: Node): void => {
    const specifier = staticModuleSpecifier(node);
    if (specifier !== undefined) {
      specifiers.add(specifier);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return [...specifiers].sort((left, right) => left.localeCompare(right));
}

function normalizePathReference(
  sourcePath: string,
  targetPath: string,
): string {
  const absoluteTarget = isAbsolute(targetPath)
    ? targetPath
    : resolve(dirname(sourcePath), targetPath);
  const relativeTarget = relative(dirname(sourcePath), absoluteTarget)
    .split(sep)
    .join("/");
  return relativeTarget.startsWith(".")
    ? relativeTarget
    : `./${relativeTarget}`;
}

function staticModuleSpecifier(node: Node): string | undefined {
  let specifier: string | undefined;
  if (isImportDeclaration(node) || isExportDeclaration(node)) {
    const moduleSpecifier = node.moduleSpecifier;
    if (moduleSpecifier !== undefined && isStringLiteral(moduleSpecifier)) {
      specifier = moduleSpecifier.text;
    }
  } else if (
    isImportTypeNode(node) &&
    isLiteralTypeNode(node.argument) &&
    isStringLiteral(node.argument.literal)
  ) {
    specifier = node.argument.literal.text;
  } else if (
    isImportEqualsDeclaration(node) &&
    isExternalModuleReference(node.moduleReference) &&
    isStringLiteral(node.moduleReference.expression)
  ) {
    specifier = node.moduleReference.expression.text;
  }
  return specifier;
}

function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return [...diagnostics]
    .sort(
      (left, right) =>
        left.pos - right.pos ||
        left.code - right.code ||
        left.text.localeCompare(right.text),
    )
    .map(
      (diagnostic) =>
        `TypeScript TS${diagnostic.code} at offset ${diagnostic.pos}: ${diagnosticText(diagnostic)}`,
    )
    .join("; ");
}

function diagnosticText(diagnostic: Diagnostic): string {
  const nested = diagnostic.messageChain?.map(diagnosticText) ?? [];
  return [diagnostic.text, ...nested].join(": ");
}

function stripShebang(source: string): string {
  if (!source.startsWith("#!")) {
    return source;
  }
  const terminator = SHEBANG_LINE_TERMINATOR_PATTERN.exec(source);
  if (terminator === null || terminator.index === undefined) {
    return "";
  }
  let terminatorLength = 1;
  if (
    source[terminator.index] === "\r" &&
    source[terminator.index + 1] === "\n"
  ) {
    terminatorLength = 2;
  }
  return source.slice(terminator.index + terminatorLength);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export {
  type CurrentSourceReader,
  parseSourceDependencies,
  type SourceDependencyBackend,
  type SourceDependencyBackendFactory,
  type SourceDependencyResult,
  type SourceDocument,
  type StaticDependencyResult,
};
