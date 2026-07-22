// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  isBinaryExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  NodeFlags,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { unwrapExpression, visitNodes } from "../context.ts";

type StaticPrimitive = string | number | boolean | null;

interface StaticShape {
  readonly known: boolean;
  readonly value?: StaticPrimitive;
  /** Text before the first unknown expression in a composed value. */
  readonly leading: string;
  /** Text after the last unknown expression in a composed value. */
  readonly trailing: string;
}

type ConstBinding = Node | null;

const UNKNOWN: StaticShape = Object.freeze({
  known: false,
  leading: "",
  trailing: "",
});

/**
 * Collect only unambiguous, immutable const bindings. A duplicate name is
 * deliberately marked ambiguous rather than guessed across lexical scopes.
 */
export function collectImmutableConstBindings(
  sourceFile: SourceFile,
): ReadonlyMap<string, ConstBinding> {
  const bindings = new Map<string, ConstBinding>();
  visitNodes(sourceFile, (node) => {
    if (
      !isVariableDeclaration(node) ||
      !isIdentifier(node.name) ||
      node.initializer === undefined ||
      !isVariableDeclarationList(node.parent) ||
      (node.parent.flags & NodeFlags.Const) === 0
    ) {
      return;
    }
    const name = node.name.text;
    if (bindings.has(name)) {
      bindings.set(name, null);
      return;
    }
    bindings.set(name, node.initializer);
  });
  return bindings;
}

export function classifyStaticString(
  node: Node,
  bindings: ReadonlyMap<string, ConstBinding>,
): StaticShape {
  return evaluate(node, bindings, new Set<string>());
}

export function isSerializedComplexShape(shape: StaticShape): boolean {
  if (shape.known) {
    return (
      typeof shape.value === "string" && isSerializedComplexText(shape.value)
    );
  }
  return isAmbiguousSerializedEnvelope(shape.leading, shape.trailing);
}

function evaluate(
  node: Node,
  bindings: ReadonlyMap<string, ConstBinding>,
  resolving: ReadonlySet<string>,
): StaticShape {
  const current = unwrapExpression(node);
  if (isStringLiteral(current) || isNoSubstitutionTemplateLiteral(current)) {
    return known(current.text);
  }
  if (isNumericLiteral(current)) {
    const value = Number(current.text.replaceAll("_", ""));
    return Number.isFinite(value) ? known(value) : UNKNOWN;
  }
  if (current.kind === SyntaxKind.TrueKeyword) return known(true);
  if (current.kind === SyntaxKind.FalseKeyword) return known(false);
  if (current.kind === SyntaxKind.NullKeyword) return known(null);
  if (
    isPrefixUnaryExpression(current) &&
    current.operator === SyntaxKind.MinusToken &&
    isNumericLiteral(current.operand)
  ) {
    const value = Number(current.operand.text.replaceAll("_", ""));
    return Number.isFinite(value) ? known(-value) : UNKNOWN;
  }
  if (isIdentifier(current)) {
    const binding = bindings.get(current.text);
    if (
      binding === undefined ||
      binding === null ||
      resolving.has(current.text)
    ) {
      return UNKNOWN;
    }
    const next = new Set(resolving);
    next.add(current.text);
    return evaluate(binding, bindings, next);
  }
  if (isBinaryExpression(current)) {
    if (current.operatorToken.kind !== SyntaxKind.PlusToken) return UNKNOWN;
    const left = evaluate(current.left, bindings, resolving);
    const right = evaluate(current.right, bindings, resolving);
    return add(left, right);
  }
  if (isTemplateExpression(current)) {
    const parts: StaticShape[] = [known(current.head.text)];
    for (const span of current.templateSpans) {
      const expression = evaluate(span.expression, bindings, resolving);
      parts.push(
        expression.known ? known(stringify(expression.value)) : expression,
        known(span.literal.text),
      );
    }
    return concatenate(parts);
  }
  return UNKNOWN;
}

function add(left: StaticShape, right: StaticShape): StaticShape {
  if (left.known && right.known) {
    if (typeof left.value === "string" || typeof right.value === "string") {
      return known(`${stringify(left.value)}${stringify(right.value)}`);
    }
    if (typeof left.value === "number" && typeof right.value === "number") {
      return known(left.value + right.value);
    }
    return UNKNOWN;
  }
  return concatenate([left, right]);
}

function concatenate(parts: readonly StaticShape[]): StaticShape {
  if (parts.every((part) => part.known)) {
    return known(parts.map((part) => stringify(part.value)).join(""));
  }

  let leading = "";
  let seenUnknown = false;
  for (const part of parts) {
    if (seenUnknown) break;
    if (part.known) {
      leading += stringify(part.value);
      continue;
    }
    leading += part.leading;
    seenUnknown = true;
  }

  let trailing = "";
  seenUnknown = false;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part === undefined) continue;
    if (seenUnknown) break;
    if (part.known) {
      trailing = `${stringify(part.value)}${trailing}`;
      continue;
    }
    trailing = `${part.trailing}${trailing}`;
    seenUnknown = true;
  }
  return { known: false, leading, trailing };
}

function known(value: StaticPrimitive): StaticShape {
  const text = stringify(value);
  return { known: true, value, leading: text, trailing: text };
}

function stringify(value: StaticPrimitive | undefined): string {
  if (value === null) return "null";
  return String(value);
}

function isSerializedComplexText(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function isAmbiguousSerializedEnvelope(
  leading: string,
  trailing: string,
): boolean {
  const start = leading.trimStart();
  const end = trailing.trimEnd();
  if (start.length === 0 || end.length === 0) return false;
  const opening = start[0];
  const closing = end.at(-1);
  return (
    (opening === "{" && closing === "}") || (opening === "[" && closing === "]")
  );
}

export type { StaticShape };
