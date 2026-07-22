// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  type CallExpression,
  isCallExpression,
  isCaseClause,
  isIdentifier,
  isIfStatement,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isRegularExpressionLiteral,
  isStringLiteral,
  isThrowStatement,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { semanticDigest } from "../typescript/editor.ts";
import { visitNodes } from "./context.ts";
import type { ParsedPolicyChange } from "./contract.ts";

const EXPECT_MATCHERS = new Set([
  "toBe",
  "toContain",
  "toEqual",
  "toMatch",
  "toReject",
  "toStrictEqual",
  "toThrow",
  "toThrowError",
]);
const ASSERT_METHODS = new Set([
  "deepEqual",
  "equal",
  "match",
  "rejects",
  "strictEqual",
  "throws",
]);
const NEGATIVE_HELPER_PATTERN =
  /(?:assert|expect).*(?:error|fail|reject|throw)/iu;
const ERROR_BRANCH_PATTERN = /(?:error|exercise.*fail|fail|reject|throw)/iu;
const ERROR_CONDITION_PATTERN = /(?:code|error|fail|reason|reject|status)/iu;

export function observeFailureCodes(
  change: ParsedPolicyChange,
  declaredCodes: ReadonlySet<string>,
): readonly string[] {
  const baselineCounts = semanticEvidenceCounts(change.baseline);
  const observed = new Set<string>();
  visitNodes(change.candidate, (node) => {
    if (!isEvidenceNode(node)) {
      return;
    }
    const digest = semanticDigest(node);
    const remaining = baselineCounts.get(digest) ?? 0;
    if (remaining > 0) {
      baselineCounts.set(digest, remaining - 1);
      return;
    }
    if (isCallExpression(node) && isNegativeAssertion(node)) {
      collectCodes(node, declaredCodes, observed);
      return;
    }
    if (
      isIfStatement(node) &&
      conditionIsErrorRelated(node.expression) &&
      (branchExercisesFailure(node.thenStatement) ||
        (node.elseStatement !== undefined &&
          branchExercisesFailure(node.elseStatement)))
    ) {
      collectCodes(node.expression, declaredCodes, observed);
      return;
    }
    if (isCaseClause(node) && branchExercisesFailure(node)) {
      collectCodes(node.expression, declaredCodes, observed);
    }
  });
  return Object.freeze([...observed].sort(compareText));
}

function semanticEvidenceCounts(
  sourceFile: SourceFile | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (sourceFile === null) {
    return counts;
  }
  visitNodes(sourceFile, (node) => {
    if (isEvidenceNode(node)) {
      const digest = semanticDigest(node);
      counts.set(digest, (counts.get(digest) ?? 0) + 1);
    }
  });
  return counts;
}

function isEvidenceNode(node: Node): boolean {
  return (
    (isCallExpression(node) && isNegativeAssertion(node)) ||
    (isIfStatement(node) &&
      conditionIsErrorRelated(node.expression) &&
      (branchExercisesFailure(node.thenStatement) ||
        (node.elseStatement !== undefined &&
          branchExercisesFailure(node.elseStatement)))) ||
    (isCaseClause(node) && branchExercisesFailure(node))
  );
}

function isNegativeAssertion(node: CallExpression): boolean {
  const expression = node.expression;
  if (isIdentifier(expression)) {
    return (
      expression.text === "assert" ||
      expression.text === "expect" ||
      NEGATIVE_HELPER_PATTERN.test(expression.text)
    );
  }
  if (!isPropertyAccessExpression(expression)) {
    return false;
  }
  if (
    EXPECT_MATCHERS.has(expression.name.text) &&
    hasExpectRoot(expression.expression)
  ) {
    return true;
  }
  return (
    ASSERT_METHODS.has(expression.name.text) &&
    isIdentifier(expression.expression) &&
    expression.expression.text === "assert"
  );
}

function hasExpectRoot(node: Node): boolean {
  let current = node;
  while (isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return (
    isCallExpression(current) &&
    isIdentifier(current.expression) &&
    current.expression.text === "expect"
  );
}

function conditionIsErrorRelated(node: Node): boolean {
  const relatedProperties = new Set<Node>();
  visitNodes(node, (candidate) => {
    if (
      relatedProperties.size === 0 &&
      isPropertyAccessExpression(candidate) &&
      ERROR_CONDITION_PATTERN.test(candidate.name.text)
    ) {
      relatedProperties.add(candidate);
    }
  });
  return relatedProperties.size > 0;
}

function branchExercisesFailure(node: Node): boolean {
  let exercised = false;
  visitNodes(node, (candidate) => {
    if (exercised) {
      return;
    }
    if (isThrowStatement(candidate)) {
      exercised = true;
      return;
    }
    if (isCallExpression(candidate)) {
      exercised = isNegativeAssertion(candidate) || errorCallee(candidate);
    }
  });
  return exercised;
}

function errorCallee(node: CallExpression): boolean {
  if (isIdentifier(node.expression)) {
    return ERROR_BRANCH_PATTERN.test(node.expression.text);
  }
  return (
    isPropertyAccessExpression(node.expression) &&
    ERROR_BRANCH_PATTERN.test(node.expression.name.text)
  );
}

function collectCodes(
  node: Node,
  declaredCodes: ReadonlySet<string>,
  observed: Set<string>,
): void {
  visitNodes(node, (candidate) => {
    const value = evidenceToken(candidate);
    if (value !== undefined && declaredCodes.has(value)) {
      observed.add(value);
    }
  });
}

function evidenceToken(node: Node): string | undefined {
  if (
    isIdentifier(node) ||
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  if (isRegularExpressionLiteral(node)) {
    const text = node.text;
    const match = /^\/(.*)\/[a-z]*$/iu.exec(text);
    return match?.[1];
  }
  return undefined;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
