// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  type BinaryExpression,
  type CallExpression,
  isBinaryExpression,
  isCallExpression,
  isPropertyAccessExpression,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import { identifierText, unwrapExpression } from "../context.ts";

const EXPECT_EQUALITY_MATCHERS = new Set([
  "equal",
  "equals",
  "toBe",
  "toEqual",
  "toMatch",
  "toStrictEqual",
]);
const ASSERT_EQUALITY_METHODS = new Set([
  "deepEqual",
  "deepStrictEqual",
  "equal",
  "notDeepEqual",
  "notDeepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "strictEqual",
]);

interface AssertionOperands {
  readonly matcher: string;
  readonly actual: Node;
  readonly expected: Node;
}

function assertionOperands(
  node: CallExpression,
): AssertionOperands | undefined {
  const expectAssertion = expectOperands(node);
  if (expectAssertion !== undefined) {
    return expandBooleanComparison(expectAssertion);
  }
  const assertMethod = assertMethodOperands(node);
  if (assertMethod !== undefined) {
    return expandBooleanComparison(assertMethod);
  }
  const direct = directAssertOperands(node);
  if (direct === undefined) {
    return;
  }
  return expandBooleanComparison(direct);
}

function expectOperands(node: CallExpression): AssertionOperands | undefined {
  if (
    node.arguments.length !== 1 ||
    !isPropertyAccessExpression(node.expression)
  ) {
    return;
  }
  const matcher = node.expression.name.text;
  if (!EXPECT_EQUALITY_MATCHERS.has(matcher)) {
    return;
  }
  const expectCall = findExpectCall(node.expression.expression);
  const [expected] = node.arguments;
  const [actual] = expectCall?.arguments ?? [];
  if (
    expectCall?.arguments.length !== 1 ||
    actual === undefined ||
    expected === undefined
  ) {
    return;
  }
  return { matcher, actual, expected };
}

function findExpectCall(node: Node): CallExpression | undefined {
  let current = unwrapExpression(node);
  while (isPropertyAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  if (
    isCallExpression(current) &&
    identifierText(current.expression) === "expect"
  ) {
    return current;
  }
  return;
}

function assertMethodOperands(
  node: CallExpression,
): AssertionOperands | undefined {
  if (
    node.arguments.length < 2 ||
    !isPropertyAccessExpression(node.expression) ||
    !ASSERT_EQUALITY_METHODS.has(node.expression.name.text) ||
    identifierText(node.expression.expression) !== "assert"
  ) {
    return;
  }
  const [actual, expected] = node.arguments;
  if (actual === undefined || expected === undefined) {
    return;
  }
  return { matcher: node.expression.name.text, actual, expected };
}

function directAssertOperands(
  node: CallExpression,
): AssertionOperands | undefined {
  const directAssert = identifierText(node.expression) === "assert";
  const assertOk =
    isPropertyAccessExpression(node.expression) &&
    identifierText(node.expression.expression) === "assert" &&
    node.expression.name.text === "ok";
  const namedAssert =
    identifierText(node.expression) === "assertEquals" ||
    identifierText(node.expression) === "assertStrictEquals" ||
    identifierText(node.expression) === "assertNotEquals" ||
    identifierText(node.expression) === "assertNotStrictEquals";
  if (namedAssert && node.arguments.length >= 2) {
    const [actual, expected] = node.arguments;
    if (actual === undefined || expected === undefined) {
      return;
    }
    return { matcher: "strictEqual", actual, expected };
  }
  if (!(directAssert || assertOk) || node.arguments.length === 0) {
    return;
  }
  const [candidate] = node.arguments;
  const comparison = equalityExpression(candidate);
  if (comparison === undefined) {
    return;
  }
  return {
    matcher: "strictEqual",
    actual: comparison.left,
    expected: comparison.right,
  };
}

function expandBooleanComparison(
  assertion: AssertionOperands,
): AssertionOperands {
  const { actual, expected } = assertion;
  const comparison = equalityExpression(actual);
  if (comparison === undefined || !isBooleanLiteral(expected)) {
    return assertion;
  }
  return {
    matcher: assertion.matcher,
    actual: comparison.left,
    expected: comparison.right,
  };
}

function equalityExpression(
  node: Node | undefined,
): BinaryExpression | undefined {
  if (node === undefined) {
    return;
  }
  const current = unwrapExpression(node);
  if (!isBinaryExpression(current)) {
    return;
  }
  switch (current.operatorToken.kind) {
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken:
      return current;
    default:
      return;
  }
}

function isBooleanLiteral(node: Node): boolean {
  const kind = unwrapExpression(node).kind;
  return kind === SyntaxKind.TrueKeyword || kind === SyntaxKind.FalseKeyword;
}

export function extractAssertionOperands(
  node: CallExpression,
): AssertionOperands | undefined {
  return assertionOperands(node);
}

export type { AssertionOperands };
