// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes parser and AST APIs through unstable package exports.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { create as createRunWorkspace } from "@skizzles/run-workspace";
import {
  type BinaryExpression,
  type CallExpression,
  isBinaryExpression,
  isCallExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isNamedExports,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableStatement,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API, type Diagnostic } from "typescript/unstable/async";
import type { ParsedSecuritySource, SecurityCallSite } from "../contract.ts";
import { collectSecurityImport } from "./imports.ts";

const maximumCandidateBytes = 4 * 1024 * 1024;
const middlewareNames = new Set([
  "rateLimit",
  "rateLimiter",
  "withRateLimit",
  "requireRateLimit",
  "auditLog",
  "auditLogger",
  "withAuditLog",
  "recordAudit",
  "sanitize",
  "sanitizeInput",
  "withSanitize",
  "withSanitization",
  "validateInput",
]);
const executionNames = new Set([
  "exec",
  "execFile",
  "spawn",
  "spawnSync",
  "runCommand",
  "runProcess",
]);
const databaseNames = new Set([
  "query",
  "execute",
  "executeQuery",
  "rawQuery",
  "unsafeQuery",
  "sql",
]);
const networkNames = new Set([
  "fetch",
  "request",
  "sendRequest",
  "axios",
  "httpRequest",
]);

export type SecurityParseResult =
  | Readonly<{ status: "parsed"; source: ParsedSecuritySource }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_CANDIDATE" | "SYNTAX_ERROR" | "PARSER_REJECTED";
      diagnostics: readonly string[];
    }>;

export async function parseSecurityCandidate(
  path: string,
  bytes: Uint8Array,
): Promise<SecurityParseResult> {
  if (!validPath(path) || bytes.byteLength > maximumCandidateBytes) {
    return rejected("INVALID_CANDIDATE", []);
  }
  const extension = extensionFor(path);
  if (extension === undefined) return rejected("INVALID_CANDIDATE", []);
  let workspace: Awaited<ReturnType<typeof createRunWorkspace>> | undefined;
  let api: API | undefined;
  let snapshot: Awaited<ReturnType<API["updateSnapshot"]>> | undefined;
  let result: SecurityParseResult = rejected("PARSER_REJECTED", []);
  let cleanupRejected = false;
  try {
    workspace = await createRunWorkspace();
    const materializedPath = workspace.path(`candidate${extension}`);
    const handle = await open(
      materializedPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    api = new API();
    snapshot = await api.updateSnapshot({ openFiles: [materializedPath] });
    const project = await snapshot.getDefaultProjectForFile(materializedPath);
    if (project === undefined) {
      result = rejected("PARSER_REJECTED", []);
    } else {
      const diagnostics =
        await project.program.getSyntacticDiagnostics(materializedPath);
      if (diagnostics.length > 0) {
        result = rejected("SYNTAX_ERROR", diagnostics.map(formatDiagnostic));
      } else {
        const sourceFile =
          await project.program.getSourceFile(materializedPath);
        result =
          sourceFile === undefined || sourceFile.text !== decode(bytes)
            ? rejected("PARSER_REJECTED", [])
            : parsed(path, bytes, sourceFile);
      }
    }
  } catch (error) {
    result = rejected("PARSER_REJECTED", [errorMessage(error)]);
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
        const report = await workspace.close();
        if (report.state !== "deleted") cleanupRejected = true;
      } catch {
        cleanupRejected = true;
      }
    }
  }
  return cleanupRejected
    ? rejected("PARSER_REJECTED", ["cleanup failed"])
    : result;
}

function parsed(
  path: string,
  bytes: Uint8Array,
  sourceFile: SourceFile,
): SecurityParseResult {
  const imports = new Map<string, readonly string[]>();
  const importAliases = new Map<string, string>();
  const importBindings = new Map<
    string,
    Readonly<{ readonly module: string; readonly imported: string }>
  >();
  const declaredNames = new Set<string>();
  const exportedNames = new Set<string>();
  const middleware = new Set<string>();
  const callSites: SecurityCallSite[] = [];
  sourceFile.statements.forEach((statement) => {
    collectSecurityImport(statement, imports, importAliases, importBindings);
    collectDeclarationName(statement, declaredNames);
    collectExportedName(statement, exportedNames);
  });
  visit(sourceFile, (node) => {
    if (isIdentifier(node) && middlewareNames.has(node.text)) {
      middleware.add(node.text);
    }
    if (isCallExpression(node)) {
      const localName = callName(node);
      if (localName === undefined) return;
      const name = importAliases.get(localName) ?? localName;
      const capability = capabilityFor(name);
      if (middlewareNames.has(name)) middleware.add(name);
      const hasTemplateSubstitution = node.arguments.some((argument) =>
        containsTemplateSubstitution(argument),
      );
      const hasDynamicArgument = node.arguments.some(
        (argument) =>
          containsStringConcatenation(argument) ||
          hasTemplateSubstitutionIn(argument),
      );
      const position = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      callSites.push({
        name,
        capability,
        hasDynamicArgument,
        hasTemplateSubstitution,
        numericArguments: Object.freeze(numberArguments(node)),
        positionalNumericArguments: Object.freeze(
          positionalNumberArguments(node),
        ),
        stringArguments: Object.freeze(stringArguments(node)),
        objectPropertyNames: Object.freeze(objectPropertyNames(node)),
        line: position.line + 1,
        column: position.character + 1,
      });
    }
  });
  return {
    status: "parsed",
    source: Object.freeze({
      path,
      bytes: Uint8Array.from(bytes),
      sourceFile,
      imports,
      importAliases,
      importBindings,
      declaredNames,
      exportedNames,
      middlewareNames: middleware,
      callSites: Object.freeze(callSites),
    }),
  };
}

function collectDeclarationName(node: Node, names: Set<string>): void {
  if (isFunctionDeclaration(node) && node.name !== undefined)
    names.add(node.name.text);
  node.forEachChild((child) => collectDeclarationName(child, names));
}

function collectExportedName(node: Node, names: Set<string>): void {
  if (isFunctionDeclaration(node) && hasExportModifier(node)) {
    if (node.name === undefined) names.add("default");
    else names.add(node.name.text);
  }
  if (isVariableStatement(node) && hasExportModifier(node)) {
    node.declarationList.declarations.forEach((declaration) => {
      if (isIdentifier(declaration.name)) names.add(declaration.name.text);
    });
  }
  if (isExportDeclaration(node)) {
    const exportClause = node.exportClause;
    if (exportClause !== undefined && isNamedExports(exportClause)) {
      exportClause.elements.forEach((element) => {
        names.add(element.name.text);
      });
    }
  }
}

function hasExportModifier(
  node: Node & { readonly modifiers?: readonly Node[] },
): boolean {
  return (
    node.modifiers?.some(
      (modifier) => modifier.kind === SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

function numberArguments(node: CallExpression): number[] {
  const result: number[] = [];
  node.arguments.forEach((argument) => {
    visit(argument, (current) => {
      if (isNumericLiteral(current)) result.push(Number(current.text));
    });
  });
  return result;
}

function positionalNumberArguments(
  node: CallExpression,
): readonly (number | null)[] {
  return node.arguments.map((argument) =>
    isNumericLiteral(argument) ? Number(argument.text) : null,
  );
}

function stringArguments(node: CallExpression): string[] {
  const result: string[] = [];
  node.arguments.forEach((argument) => {
    visit(argument, (current) => {
      if (isStringLiteral(current)) result.push(current.text);
    });
  });
  return result;
}

function objectPropertyNames(node: CallExpression): string[] {
  const result: string[] = [];
  node.arguments.forEach((argument) => {
    visit(argument, (current) => {
      if (!isObjectLiteralExpression(current)) return;
      current.properties.forEach((property) => {
        if (isPropertyAssignment(property) && isIdentifier(property.name)) {
          result.push(property.name.text);
        }
      });
    });
  });
  return result;
}

function visit(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  node.forEachChild((child) => visit(child, visitor));
}

function callName(node: CallExpression): string | undefined {
  if (isIdentifier(node.expression)) return node.expression.text;
  if (isPropertyAccessExpression(node.expression))
    return node.expression.name.text;
  return undefined;
}

function capabilityFor(name: string): SecurityCallSite["capability"] {
  if (executionNames.has(name)) return "execution";
  if (databaseNames.has(name)) return "database";
  if (networkNames.has(name)) return "network";
  return "unknown";
}

function containsStringConcatenation(node: Node): boolean {
  let found = false;
  visit(node, (current) => {
    if (!found && isBinaryExpression(current)) {
      const binary: BinaryExpression = current;
      found = binary.operatorToken.kind === SyntaxKind.PlusToken;
    }
  });
  return found;
}

function containsTemplateSubstitution(node: Node): boolean {
  return isTemplateExpression(node) && node.templateSpans.length > 0;
}

function hasTemplateSubstitutionIn(node: Node): boolean {
  let found = false;
  visit(node, (current) => {
    if (!found && isTemplateExpression(current))
      found = current.templateSpans.length > 0;
  });
  return found;
}

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === ".." || part === "")
  );
}

function extensionFor(path: string): string | undefined {
  const extensions = [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ];
  return extensions.find((extension) => path.endsWith(extension));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  return diagnostic.text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejected(
  code: "INVALID_CANDIDATE" | "SYNTAX_ERROR" | "PARSER_REJECTED",
  diagnostics: readonly string[],
): SecurityParseResult {
  return Object.freeze({
    status: "rejected",
    code,
    diagnostics: Object.freeze([...diagnostics]),
  });
}
