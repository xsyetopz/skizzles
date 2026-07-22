import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { create as createRunWorkspace } from "@skizzles/run-workspace";
// biome-ignore lint/correctness/noUnresolvedImports: TypeScript 7 exposes its parser through this unstable package export.
import { API, type Diagnostic } from "typescript/unstable/async";
import type { ParsedTypeScriptSource } from "./contract.ts";

const maximumSourceBytes = 4 * 1024 * 1024;

export interface TypeScriptSyntaxDiagnostic {
  readonly code: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type TypeScriptParseResult =
  | Readonly<{
      status: "parsed";
      parsed: ParsedTypeScriptSource;
    }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_PARSE_INPUT"
        | "SYNTAX_REJECTED"
        | "PARSER_REJECTED"
        | "CLEANUP_REJECTED";
      diagnostics: readonly TypeScriptSyntaxDiagnostic[];
    }>;

export function parseTypeScriptSource(
  input: unknown,
): Promise<TypeScriptParseResult> {
  return parse(input).catch(() => rejected("PARSER_REJECTED"));
}

async function parse(input: unknown): Promise<TypeScriptParseResult> {
  const parsedInput = parseInput(input);
  if (parsedInput === undefined) {
    return rejected("INVALID_PARSE_INPUT");
  }
  let workspace: Awaited<ReturnType<typeof createRunWorkspace>> | undefined;
  let api: API | undefined;
  let snapshot: Awaited<ReturnType<API["updateSnapshot"]>> | undefined;
  let result: TypeScriptParseResult = rejected("PARSER_REJECTED");
  let cleanupRejected = false;
  try {
    workspace = await createRunWorkspace();
    const materializedPath = workspace.path(`source${parsedInput.extension}`);
    const handle = await open(
      materializedPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(parsedInput.sourceText, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    api = new API();
    snapshot = await api.updateSnapshot({ openFiles: [materializedPath] });
    const project = await snapshot.getDefaultProjectForFile(materializedPath);
    if (project === undefined) {
      result = rejected("PARSER_REJECTED");
    } else {
      const diagnostics =
        await project.program.getSyntacticDiagnostics(materializedPath);
      if (diagnostics.length > 0) {
        result = rejected("SYNTAX_REJECTED", diagnostics);
      } else {
        const sourceFile =
          await project.program.getSourceFile(materializedPath);
        result =
          sourceFile !== undefined && sourceFile.text === parsedInput.sourceText
            ? {
                status: "parsed",
                parsed: Object.freeze({
                  path: parsedInput.targetPath,
                  text: parsedInput.sourceText,
                  sourceFile,
                }),
              }
            : rejected("PARSER_REJECTED");
      }
    }
  } catch {
    result = rejected("PARSER_REJECTED");
  } finally {
    if (snapshot !== undefined) {
      try {
        await snapshot.dispose();
      } catch {
        cleanupRejected = true;
      }
    }
    if (api !== undefined) {
      try {
        await api.close();
      } catch {
        cleanupRejected = true;
      }
    }
    if (workspace !== undefined) {
      try {
        const close = await workspace.close();
        if (close.state !== "deleted") {
          cleanupRejected = true;
        }
      } catch {
        cleanupRejected = true;
      }
    }
  }
  return cleanupRejected ? rejected("CLEANUP_REJECTED") : result;
}

function parseInput(input: unknown):
  | {
      readonly targetPath: string;
      readonly sourceText: string;
      readonly extension:
        | ".ts"
        | ".tsx"
        | ".mts"
        | ".cts"
        | ".js"
        | ".jsx"
        | ".mjs"
        | ".cjs";
    }
  | undefined {
  const snapshot = snapshotRecord(input);
  if (
    snapshot === undefined ||
    snapshot.size !== 2 ||
    !snapshot.has("targetPath") ||
    !snapshot.has("sourceText")
  ) {
    return;
  }
  const targetPath = snapshot.get("targetPath");
  const sourceText = snapshot.get("sourceText");
  if (
    typeof targetPath !== "string" ||
    typeof sourceText !== "string" ||
    !validTargetPath(targetPath) ||
    Buffer.byteLength(sourceText) > maximumSourceBytes
  ) {
    return;
  }
  const extension = typescriptExtension(targetPath);
  if (extension === undefined) {
    return;
  }
  return Object.freeze({
    targetPath,
    sourceText,
    extension,
  });
}

function validTargetPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    typescriptExtension(value) === undefined
  ) {
    return false;
  }
  const normalized = posix.normalize(value);
  return (
    normalized === value &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function typescriptExtension(
  path: string,
):
  | ".ts"
  | ".tsx"
  | ".mts"
  | ".cts"
  | ".js"
  | ".jsx"
  | ".mjs"
  | ".cjs"
  | undefined {
  if (path.endsWith(".tsx")) return ".tsx";
  if (path.endsWith(".jsx")) return ".jsx";
  if (path.endsWith(".mts")) return ".mts";
  if (path.endsWith(".cts")) return ".cts";
  if (path.endsWith(".mjs")) return ".mjs";
  if (path.endsWith(".cjs")) return ".cjs";
  if (path.endsWith(".ts")) return ".ts";
  if (path.endsWith(".js")) return ".js";
  return;
}

function rejected(
  code: Extract<TypeScriptParseResult, { status: "rejected" }>["code"],
  diagnostics: readonly Diagnostic[] = [],
): TypeScriptParseResult {
  return Object.freeze({
    status: "rejected",
    code,
    diagnostics: Object.freeze(
      diagnostics.map((diagnostic) =>
        Object.freeze({
          code: diagnostic.code,
          start: diagnostic.pos,
          end: diagnostic.end,
          text: diagnostic.text,
        }),
      ),
    ),
  });
}

function snapshotRecord(
  value: unknown,
): ReadonlyMap<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return;
  }
  const snapshot = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return;
    }
    snapshot.set(key, descriptor.value);
  }
  return snapshot;
}
