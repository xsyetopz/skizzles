// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes the compiler API through an unstable package export.
import { relative, resolve } from "node:path";
import {
  API,
  type Diagnostic,
  DiagnosticCategory,
} from "typescript/unstable/async";
import { digestText } from "../../digest.ts";
import type {
  CompilerRunResult,
  ParsedCompilerInput,
  TrustedCompilerState,
} from "./authority-state.ts";
import type { CompilerDiagnosticEvidence } from "./contract.ts";

const maximumDiagnostics = 4096;

export async function runTypeScriptCompiler(
  state: TrustedCompilerState,
  input: ParsedCompilerInput,
): Promise<CompilerRunResult> {
  const overlays = Object.fromEntries(
    input.targets.map((target) => [target.absolutePath, target.sourceText]),
  );
  const api = new API({ cwd: state.rootPath, fs: overlayFileSystem(overlays) });
  try {
    const snapshot = await api.updateSnapshot({
      openProjects: [state.configPath],
      openFiles: input.targets.map(({ absolutePath }) => absolutePath),
    });
    try {
      const project = snapshot
        .getProjects()
        .find(({ configFileName }) => configFileName === state.configPath);
      if (project === undefined)
        throw new Error("Trusted TypeScript project was not loaded");
      const options = project.compilerOptions;
      const sourceFiles = new Set(
        (await project.program.getSourceFileNames()).map((fileName) =>
          resolve(state.rootPath, fileName),
        ),
      );
      const allTargetsIncluded = input.targets.every(({ absolutePath }) =>
        sourceFiles.has(resolve(state.rootPath, absolutePath)),
      );
      const strict =
        options.strict === true &&
        options.noImplicitAny !== false &&
        options.strictNullChecks !== false &&
        options.noUncheckedIndexedAccess === true &&
        options.exactOptionalPropertyTypes === true &&
        options.useUnknownInCatchVariables !== false;
      const groups = await Promise.all([
        project.program.getConfigFileParsingDiagnostics(),
        project.program.getProgramDiagnostics(),
        project.program.getGlobalDiagnostics(),
        project.program.getSyntacticDiagnostics(),
        project.program.getBindDiagnostics(),
        project.program.getSemanticDiagnostics(),
        project.program.getDeclarationDiagnostics(),
      ]);
      const diagnostics = normalizeDiagnostics(state.rootPath, groups.flat());
      return Object.freeze({
        allTargetsIncluded,
        strict,
        diagnostics,
        outputDigest: digestText(
          JSON.stringify({
            tool: "typescript",
            version: "7.0.2",
            allTargetsIncluded,
            strict,
            diagnostics,
          }),
        ),
      });
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
}

function overlayFileSystem(files: Readonly<Record<string, string>>) {
  return {
    readFile(fileName: string): string | undefined {
      return files[fileName];
    },
    fileExists(fileName: string) {
      let exists: boolean | undefined;
      if (Object.hasOwn(files, fileName)) {
        exists = true;
      }
      return exists;
    },
  };
}

function normalizeDiagnostics(
  root: string,
  values: readonly Diagnostic[],
): readonly CompilerDiagnosticEvidence[] {
  const seen = new Set<string>();
  const diagnostics: CompilerDiagnosticEvidence[] = [];
  for (const diagnostic of values) {
    const path =
      diagnostic.fileName === undefined
        ? "<project>"
        : repositoryPath(root, diagnostic.fileName);
    const entry = Object.freeze({
      path,
      code: `TS${diagnostic.code}`,
      severity: severity(diagnostic.category),
      start: diagnostic.pos,
      end: diagnostic.end,
      messageDigest: digestText(flattenMessage(diagnostic)),
    });
    const key = JSON.stringify(entry);
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(entry);
    }
    if (diagnostics.length >= maximumDiagnostics) break;
  }
  diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.start - right.start ||
      left.code.localeCompare(right.code),
  );
  return Object.freeze(diagnostics);
}

function repositoryPath(root: string, fileName: string): string {
  const path = relative(root, fileName).replaceAll("\\", "/");
  return path.startsWith("../") ? "<external>" : path;
}
function severity(
  category: DiagnosticCategory,
): CompilerDiagnosticEvidence["severity"] {
  if (category === DiagnosticCategory.Error) return "error";
  if (category === DiagnosticCategory.Warning) return "warning";
  if (category === DiagnosticCategory.Suggestion) return "suggestion";
  return "message";
}
function flattenMessage(diagnostic: Diagnostic): string {
  const nested = diagnostic.messageChain?.map(flattenMessage).join("\n") ?? "";
  return nested.length === 0
    ? diagnostic.text
    : `${diagnostic.text}\n${nested}`;
}
