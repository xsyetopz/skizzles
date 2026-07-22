// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  type CallExpression,
  isAsExpression,
  isCallExpression,
  isIdentifier,
  isNonNullExpression,
  isPropertyAccessExpression,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import {
  addNodeFinding,
  identifierText,
  type PolicyRuleContext,
  visitChangedNodes,
} from "./context.ts";

const SCHEMA_CALLEE_PATTERN =
  /(?:assert|check|decode|parse|safeparse|schema|validate)$/iu;

export function inspectTypeSafety(context: PolicyRuleContext): void {
  visitChangedNodes(context, (node) => {
    if (node.kind === SyntaxKind.AnyKeyword) {
      addNodeFinding(
        context,
        node,
        "EXPLICIT_ANY",
        "Use unknown and validate at the trust boundary instead of introducing any.",
      );
      return;
    }
    if (isAsExpression(node) && !isSafeAssertionTarget(node.type)) {
      addNodeFinding(
        context,
        node,
        "UNSAFE_TYPE_ASSERTION",
        "Type assertions must not substitute for validation or narrowing.",
      );
      return;
    }
    if (isTypeAssertion(node)) {
      addNodeFinding(
        context,
        node,
        "UNSAFE_TYPE_ASSERTION",
        "Angle-bracket type assertions must not substitute for validation.",
      );
      return;
    }
    if (isNonNullExpression(node)) {
      addNodeFinding(
        context,
        node,
        "UNSAFE_NON_NULL_ASSERTION",
        "Model and handle the absent state instead of suppressing it with a non-null assertion.",
      );
      return;
    }
    if (
      isCallExpression(node) &&
      isDynamicParse(node) &&
      !isSchemaBound(node)
    ) {
      addNodeFinding(
        context,
        node,
        "UNSCHEMATIZED_DYNAMIC_BOUNDARY",
        "Dynamic data must enter as unknown and pass through an explicit parser or validator.",
      );
    }
  });
}

function isSafeAssertionTarget(type: Node): boolean {
  return type.kind === SyntaxKind.UnknownKeyword || type.getText() === "const";
}

function isDynamicParse(node: CallExpression): boolean {
  if (!isPropertyAccessExpression(node.expression)) {
    return false;
  }
  if (
    identifierText(node.expression.expression) === "JSON" &&
    node.expression.name.text === "parse"
  ) {
    return true;
  }
  const owner = node.expression.expression;
  return (
    isPropertyAccessExpression(owner) &&
    identifierText(owner.expression) === "Bun" &&
    owner.name.text === "JSONC" &&
    node.expression.name.text === "parse"
  );
}

function isSchemaBound(node: CallExpression): boolean {
  const parent = node.parent;
  if (
    isAsExpression(parent) &&
    parent.type.kind === SyntaxKind.UnknownKeyword
  ) {
    return true;
  }
  if (
    isVariableDeclaration(parent) &&
    parent.initializer === node &&
    parent.type?.kind === SyntaxKind.UnknownKeyword
  ) {
    return true;
  }
  if (isCallExpression(parent) && parent.arguments.includes(node)) {
    return SCHEMA_CALLEE_PATTERN.test(calleeName(parent.expression));
  }
  return false;
}

function calleeName(node: Node): string {
  if (isIdentifier(node)) {
    return node.text;
  }
  if (isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return "";
}
