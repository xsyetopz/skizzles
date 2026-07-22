// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  isArrayLiteralExpression,
  isCallExpression,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import {
  addNodeFinding,
  identifierText,
  type PolicyRuleContext,
  unwrapExpression,
  visitChangedNodes,
} from "../context.ts";
import { extractAssertionOperands } from "./operands.ts";
import {
  classifyStaticString,
  collectImmutableConstBindings,
  isSerializedComplexShape,
} from "./static-evaluation.ts";

const IDENTITY_MATCHERS = new Set([
  "equal",
  "equals",
  "notEqual",
  "notStrictEqual",
  "strictEqual",
  "toBe",
]);

function inspect(context: PolicyRuleContext): void {
  const bindings = collectImmutableConstBindings(context.change.candidate);
  visitChangedNodes(context, (node) => {
    if (!isCallExpression(node)) {
      return;
    }
    const assertion = extractAssertionOperands(node);
    if (assertion === undefined) {
      return;
    }
    if (
      isBrittleStringComparison(assertion.actual, assertion.expected, bindings)
    ) {
      addNodeFinding(
        context,
        node,
        "BRITTLE_STRUCTURE_ASSERTION",
        "Compare parsed fields or use compareJsonSemantics instead of serialized complex text.",
      );
      return;
    }
    if (
      isIdentityMatcher(assertion.matcher) &&
      (isFreshIdentity(assertion.actual) || isFreshIdentity(assertion.expected))
    ) {
      addNodeFinding(
        context,
        node,
        "BRITTLE_STRUCTURE_ASSERTION",
        "Object and array assertions must use structural equality, not reference identity.",
      );
    }
  });
}

function isBrittleStringComparison(
  actual: Node,
  expected: Node,
  bindings: ReadonlyMap<string, Node | null>,
): boolean {
  if (
    isStructuredStringification(actual) ||
    isStructuredStringification(expected)
  ) {
    return true;
  }
  const actualShape = classifyStaticString(actual, bindings);
  const expectedShape = classifyStaticString(expected, bindings);
  const hasStringSignal =
    (actualShape.known && typeof actualShape.value === "string") ||
    (expectedShape.known && typeof expectedShape.value === "string") ||
    actualShape.leading.length > 0 ||
    actualShape.trailing.length > 0 ||
    expectedShape.leading.length > 0 ||
    expectedShape.trailing.length > 0;
  if (!hasStringSignal) {
    return false;
  }
  return (
    isSerializedComplexShape(actualShape) ||
    isSerializedComplexShape(expectedShape) ||
    isStructurallyComplex(actual) ||
    isStructurallyComplex(expected)
  );
}

function isStructuredStringification(node: Node): boolean {
  const current = unwrapExpression(node);
  if (
    !(
      isCallExpression(current) &&
      isPropertyAccessExpression(current.expression)
    ) ||
    identifierText(current.expression.expression) !== "JSON" ||
    current.expression.name.text !== "stringify"
  ) {
    return false;
  }
  const [value] = current.arguments;
  return value !== undefined && !isScalarLiteral(value);
}

function isStructurallyComplex(node: Node): boolean {
  const current = unwrapExpression(node);
  return (
    isObjectLiteralExpression(current) ||
    isArrayLiteralExpression(current) ||
    isNewExpression(current) ||
    isComplexJsonCall(current)
  );
}

function isComplexJsonCall(node: Node): boolean {
  if (
    !(isCallExpression(node) && isPropertyAccessExpression(node.expression))
  ) {
    return false;
  }
  const { expression, name } = node.expression;
  if (
    identifierText(expression) !== "JSON" ||
    (name.text !== "parse" && name.text !== "stringify")
  ) {
    return false;
  }
  if (name.text === "parse") {
    return true;
  }
  const [value] = node.arguments;
  return value !== undefined && !isScalarLiteral(value);
}

function isScalarLiteral(node: Node): boolean {
  const current = unwrapExpression(node);
  return (
    isStringLiteral(current) ||
    isNoSubstitutionTemplateLiteral(current) ||
    isNumericLiteral(current) ||
    current.kind === SyntaxKind.TrueKeyword ||
    current.kind === SyntaxKind.FalseKeyword ||
    current.kind === SyntaxKind.NullKeyword
  );
}

function isIdentityMatcher(matcher: string): boolean {
  return IDENTITY_MATCHERS.has(matcher);
}

function isFreshIdentity(node: Node): boolean {
  const current = unwrapExpression(node);
  return (
    isObjectLiteralExpression(current) ||
    isArrayLiteralExpression(current) ||
    isNewExpression(current)
  );
}

export function inspectAssertions(context: PolicyRuleContext): void {
  inspect(context);
}
