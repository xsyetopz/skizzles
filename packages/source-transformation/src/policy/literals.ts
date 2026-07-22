// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNewExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  NodeFlags,
  SyntaxKind,
} from "typescript/unstable/ast";
import {
  addNodeFinding,
  hasAncestor,
  type PolicyRuleContext,
  primitiveLiteral,
  propertyNameText,
  unwrapExpression,
  visitNodes,
} from "./context.ts";
import type { LiteralRegistrySnapshot } from "./literal/contract.ts";
import { recoverLiteralRegistrySnapshot } from "./literal/registry.ts";

const DIAGNOSTIC_CALLEE_PATTERN =
  /(?:debug|diagnostic|error|info|log|message|trace|warn)$/iu;
const DISCRIMINANT_NAMES = new Set(["code", "kind", "state", "status", "type"]);

export function inspectPolicyLiterals(
  context: PolicyRuleContext,
  snapshot: LiteralRegistrySnapshot,
): void {
  if (context.change.ownership !== "production") return;
  const recovered = recoverLiteralRegistrySnapshot(snapshot);
  if (recovered.status !== "recovered") {
    throw new Error("literal registry snapshot is not authentic");
  }
  const registryObject = findRegistryObject(
    context,
    recovered.registryPath,
    recovered.exportName,
  );
  visitNodes(context.change.candidate, (node) => {
    if (
      !context.changedNodes.has(node) ||
      isNestedNegativeNumericLiteral(node)
    ) {
      return;
    }
    const literal = primitiveLiteral(node);
    if (literal === undefined || hasSyntaxExemption(node, literal.value))
      return;
    const policySensitive =
      typeof literal.value === "number"
        ? isPolicyNumber(node, literal.value)
        : isPolicyString(node, literal.value);
    if (!policySensitive) return;
    if (
      registryObject !== undefined &&
      registeredProperty(
        node,
        registryObject,
        recovered.entriesByKey,
        literal.value,
      )
    ) {
      return;
    }
    addNodeFinding(
      context,
      numericFindingNode(node),
      "UNREGISTERED_LITERAL",
      `Policy-sensitive ${typeof literal.value} literal must be registered in ${recovered.registryPath} and referenced through ${recovered.exportName}.`,
    );
  });
}

function findRegistryObject(
  context: PolicyRuleContext,
  registryPath: string,
  exportName: string,
): Node | undefined {
  if (context.change.path !== registryPath) return;
  for (const statement of context.change.candidate.statements) {
    if (
      !(
        isVariableStatement(statement) &&
        statement.declarationList.flags & NodeFlags.Const &&
        statement.modifiers?.some(
          ({ kind }) => kind === SyntaxKind.ExportKeyword,
        )
      ) ||
      statement.declarationList.declarations.length !== 1
    ) {
      continue;
    }
    const declaration = statement.declarationList.declarations[0];
    if (
      declaration === undefined ||
      !isIdentifier(declaration.name) ||
      declaration.name.text !== exportName ||
      declaration.initializer === undefined ||
      !isSatisfiesExpression(declaration.initializer)
    ) {
      continue;
    }
    const object = unwrapExpression(declaration.initializer);
    if (isObjectLiteralExpression(object)) return object;
  }
  return undefined;
}

function registeredProperty(
  node: Node,
  registryObject: Node,
  entries: ReadonlyMap<
    string,
    Readonly<{ key: string; value: string | number }>
  >,
  value: string | number,
): boolean {
  const literalNode = numericFindingNode(node);
  const property = literalNode.parent;
  if (
    !isPropertyAssignment(property) ||
    property.parent !== registryObject ||
    unwrapExpression(property.initializer) !== literalNode
  ) {
    return false;
  }
  const key = propertyNameText(property.name);
  if (key === undefined) return false;
  const entry = entries.get(key);
  return entry !== undefined && entry.value === value;
}

function hasSyntaxExemption(node: Node, value: string | number): boolean {
  if (typeof value === "number") {
    if (value === 0 || value === 1) return true;
    return value === -1 && isCollectionIndex(node);
  }
  if (hasAncestor(node, isImportDeclaration)) return true;
  const parent = node.parent;
  if (
    isPropertyAssignment(parent) &&
    parent.initializer === node &&
    DISCRIMINANT_NAMES.has((propertyNameText(parent.name) ?? "").toLowerCase())
  ) {
    return true;
  }
  return (
    (isCallExpression(parent) || isNewExpression(parent)) &&
    includesNode(parent.arguments, node) &&
    isDiagnosticCall(parent.expression)
  );
}

function isCollectionIndex(node: Node): boolean {
  const literal = numericFindingNode(node);
  const parent = literal.parent;
  return (
    isCallExpression(parent) &&
    includesNode(parent.arguments, literal) &&
    isPropertyAccessExpression(parent.expression) &&
    parent.expression.name.text === "at"
  );
}

function isNestedNegativeNumericLiteral(node: Node): boolean {
  return (
    isNumericLiteral(node) &&
    isPrefixUnaryExpression(node.parent) &&
    node.parent.operator === SyntaxKind.MinusToken
  );
}

function isPolicyNumber(node: Node, value: number): boolean {
  if (value === 0 || value === 1) return false;
  const findingNode = numericFindingNode(node);
  const parent = findingNode.parent;
  if (
    (isCallExpression(parent) || isNewExpression(parent)) &&
    includesNode(parent.arguments, findingNode)
  ) {
    return !isDiagnosticCall(parent.expression);
  }
  if (isBinaryExpression(parent)) return true;
  return (
    (isPropertyAssignment(parent) &&
      unwrapExpression(parent.initializer) === findingNode) ||
    isVariableDeclaration(parent)
  );
}

function numericFindingNode(node: Node): Node {
  return isNumericLiteral(node) &&
    isPrefixUnaryExpression(node.parent) &&
    node.parent.operator === SyntaxKind.MinusToken
    ? node.parent
    : node;
}

function isPolicyString(node: Node, value: string): boolean {
  if (value.length === 0) return false;
  const parent = node.parent;
  if (isBinaryExpression(parent)) return true;
  if (
    (isCallExpression(parent) || isNewExpression(parent)) &&
    includesNode(parent.arguments, node)
  ) {
    return !isDiagnosticCall(parent.expression);
  }
  return (
    (isPropertyAssignment(parent) && parent.initializer === node) ||
    isVariableDeclaration(parent)
  );
}

function includesNode(
  nodes: readonly Node[] | undefined,
  expected: Node,
): boolean {
  return nodes?.some((node) => node === expected) ?? false;
}

function isDiagnosticCall(expression: Node): boolean {
  if (isIdentifier(expression)) {
    return (
      expression.text === "Error" ||
      DIAGNOSTIC_CALLEE_PATTERN.test(expression.text)
    );
  }
  return (
    isPropertyAccessExpression(expression) &&
    DIAGNOSTIC_CALLEE_PATTERN.test(expression.name.text)
  );
}
