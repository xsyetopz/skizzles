// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes its parsed source contract through this unstable package export.
import {
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { type Digest, digestText } from "../digest.ts";
import type {
  DeclarationKind,
  LocatedDeclaration,
  ParsedTypeScriptSource,
  TypeScriptDeclaration,
  TypeScriptEditReceipt,
  TypeScriptEditResult,
  TypeScriptNodeOperation,
} from "./contract.ts";

const encoder = new TextEncoder();

export function listTypeScriptDeclarations(
  parsed: ParsedTypeScriptSource,
): readonly TypeScriptDeclaration[] {
  return Object.freeze(
    locateDeclarations(parsed.sourceFile)
      .map(({ node: _node, ...declaration }) => Object.freeze(declaration))
      .sort(
        (left, right) =>
          left.start - right.start ||
          left.kind.localeCompare(right.kind) ||
          left.name.localeCompare(right.name),
      ),
  );
}

export function editTypeScriptDeclarations(input: {
  readonly parsed: ParsedTypeScriptSource;
  readonly objective: "behavioral" | "format-only";
  readonly operations: readonly TypeScriptNodeOperation[];
  readonly parseCandidate: (text: string) => Promise<ParsedTypeScriptSource>;
}): Promise<TypeScriptEditResult> {
  return edit(input).catch(() => rejected("INVALID_EDIT"));
}

async function edit(input: {
  readonly parsed: ParsedTypeScriptSource;
  readonly objective: "behavioral" | "format-only";
  readonly operations: readonly TypeScriptNodeOperation[];
  readonly parseCandidate: (text: string) => Promise<ParsedTypeScriptSource>;
}): Promise<TypeScriptEditResult> {
  if (
    !(
      validParsed(input.parsed) &&
      validObjective(input.objective) &&
      Array.isArray(input.operations)
    ) ||
    input.operations.length === 0 ||
    input.operations.length > 256 ||
    typeof input.parseCandidate !== "function"
  ) {
    return rejected("INVALID_EDIT");
  }
  let text = input.parsed.text;
  let parsed = input.parsed;
  const changedNodeDigests: Digest[] = [];
  for (const operation of input.operations) {
    if (!validOperation(operation)) return rejected("INVALID_EDIT");
    const matches = locateDeclarations(parsed.sourceFile).filter(
      (candidate) =>
        candidate.kind === operation.selector.kind &&
        candidate.name === operation.selector.name,
    );
    if (matches.length === 0) return rejected("NODE_NOT_FOUND");
    if (matches.length !== 1) return rejected("NODE_AMBIGUOUS");
    const [selected] = matches;
    if (
      selected === undefined ||
      selected.nodeDigest !== operation.selector.expectedNodeDigest
    ) {
      return rejected("NODE_DRIFTED");
    }
    changedNodeDigests.push(selected.nodeDigest);
    const replacement = operation.kind === "delete" ? "" : operation.source;
    const [start, end] = operationSpan(operation.kind, selected);
    text = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
    parsed = await input.parseCandidate(text);
    if (!validParsed(parsed) || parsed.text !== text) {
      return rejected("INVALID_EDIT");
    }
  }
  const baselineSemanticDigest = semanticDigest(input.parsed.sourceFile);
  const candidateSemanticDigest = semanticDigest(parsed.sourceFile);
  if (
    input.objective === "behavioral" &&
    baselineSemanticDigest === candidateSemanticDigest
  ) {
    return rejected("SEMANTIC_NOOP");
  }
  if (
    input.objective === "format-only" &&
    baselineSemanticDigest !== candidateSemanticDigest
  ) {
    return rejected("SEMANTIC_DRIFT");
  }
  const candidateBytes = encoder.encode(text);
  const receipt: TypeScriptEditReceipt = Object.freeze({
    path: input.parsed.path,
    objective: input.objective,
    baselineDigest: digestText(input.parsed.text),
    baselineSemanticDigest,
    candidateDigest: digestText(text),
    candidateSemanticDigest,
    candidateBytes: Object.freeze([...candidateBytes]),
    changedNodeDigests: Object.freeze(changedNodeDigests),
  });
  return { status: "edited", receipt };
}

function locateDeclarations(sourceFile: SourceFile): LocatedDeclaration[] {
  const declarations: LocatedDeclaration[] = [];
  for (const node of sourceFile.statements) {
    const identity = declarationIdentity(node);
    if (identity === undefined) continue;
    const start = node.getStart(sourceFile);
    declarations.push({
      ...identity,
      node,
      start,
      end: node.end,
      nodeDigest: semanticDigest(node),
    });
  }
  return declarations;
}

function declarationIdentity(
  node: Node,
): { readonly kind: DeclarationKind; readonly name: string } | undefined {
  if (isFunctionDeclaration(node) && node.name !== undefined) {
    return { kind: "function", name: node.name.text };
  }
  if (isClassDeclaration(node) && node.name !== undefined) {
    return { kind: "class", name: node.name.text };
  }
  if (isInterfaceDeclaration(node)) {
    return { kind: "interface", name: node.name.text };
  }
  if (isTypeAliasDeclaration(node)) {
    return { kind: "type", name: node.name.text };
  }
  if (isEnumDeclaration(node)) {
    return { kind: "enum", name: node.name.text };
  }
  return void 0;
}

export function semanticDigest(node: Node): Digest {
  const parts: string[] = [];
  const visit = (current: Node): void => {
    parts.push(String(current.kind));
    let children = 0;
    current.forEachChild((child) => {
      children += 1;
      visit(child);
    });
    if (children === 0) parts.push(current.getText());
    parts.push(";");
  };
  visit(node);
  return digestText(parts.join("\0"));
}

function operationSpan(
  kind: TypeScriptNodeOperation["kind"],
  declaration: LocatedDeclaration,
): readonly [number, number] {
  if (kind === "insert-before") return [declaration.start, declaration.start];
  if (kind === "insert-after") return [declaration.end, declaration.end];
  return [declaration.start, declaration.end];
}

function validParsed(value: ParsedTypeScriptSource): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.text === "string" &&
    typeof value.sourceFile === "object" &&
    value.sourceFile !== null &&
    typeof value.sourceFile.forEachChild === "function" &&
    Array.isArray(value.sourceFile.statements)
  );
}

function validOperation(value: TypeScriptNodeOperation): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (
    value.kind !== "replace" &&
    value.kind !== "insert-before" &&
    value.kind !== "insert-after" &&
    value.kind !== "delete"
  ) {
    return false;
  }
  const selector = value.selector;
  if (
    typeof selector !== "object" ||
    selector === null ||
    !validDeclarationKind(selector.kind) ||
    typeof selector.name !== "string" ||
    selector.name.length === 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(selector.expectedNodeDigest)
  ) {
    return false;
  }
  return (
    value.kind === "delete" ||
    (typeof value.source === "string" && value.source.length <= 1_048_576)
  );
}

function validDeclarationKind(value: unknown): value is DeclarationKind {
  return (
    value === "function" ||
    value === "class" ||
    value === "interface" ||
    value === "type" ||
    value === "enum"
  );
}

function validObjective(value: unknown): value is "behavioral" | "format-only" {
  return value === "behavioral" || value === "format-only";
}

function rejected(
  code: Extract<TypeScriptEditResult, { status: "rejected" }>["code"],
): TypeScriptEditResult {
  return { status: "rejected", code };
}
