// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type BindingName,
  type Expression,
  isElementAccessExpression,
  isIdentifier,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import type { SecurityFindingCode } from "../contract.ts";
import {
  addFlowFinding,
  type FlowContext,
  flowPoint,
  sinkCapability,
  visitFlowNodes,
} from "./flow.ts";

const rawRoots = new Set(["Bun", "globalThis", "process"]);

export function inspectRawPrimitiveReferences(
  sourceFile: SourceFile,
  context: FlowContext,
): void {
  const aliases = collectRawRootAliases(sourceFile);
  visitFlowNodes(sourceFile, (node) => {
    if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
      const name = memberName(node);
      if (name !== undefined && rawRoot(node.expression, aliases))
        reportRaw(name, node, context);
      if (
        name === undefined &&
        isElementAccessExpression(node) &&
        rawRoot(node.expression, aliases)
      )
        reportDynamicRaw(node, context);
    }
    if (
      isVariableDeclaration(node) &&
      isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      rawRoot(node.initializer, aliases)
    )
      inspectBinding(node.name, node, context);
  });
}

function reportDynamicRaw(node: Node, context: FlowContext): void {
  addFlowFinding(
    "DYNAMIC_SECURITY_DISPATCH",
    node,
    "Computed access to a raw global primitive is not permitted.",
    [flowPoint(node, context, "dynamic-raw-reference")],
    context,
  );
}

function collectRawRootAliases(sourceFile: SourceFile): ReadonlySet<string> {
  const aliases = new Set(rawRoots);
  const declarations: Array<{
    readonly initializer: Expression;
    readonly name: string;
  }> = [];
  visitFlowNodes(sourceFile, (node) => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer !== undefined
    )
      declarations.push({
        initializer: node.initializer,
        name: node.name.text,
      });
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const { initializer, name } of declarations) {
      if (!aliases.has(name) && rawRoot(initializer, aliases)) {
        aliases.add(name);
        changed = true;
      }
    }
  }
  return aliases;
}

function rawRoot(
  expression: Expression,
  aliases: ReadonlySet<string>,
): boolean {
  let current = expression;
  while (isParenthesizedExpression(current)) current = current.expression;
  if (isIdentifier(current)) return aliases.has(current.text);
  if (isPropertyAccessExpression(current) || isElementAccessExpression(current))
    return rawRoot(current.expression, aliases);
  return false;
}

function inspectBinding(
  binding: BindingName,
  node: Node,
  context: FlowContext,
): void {
  if (!isObjectBindingPattern(binding)) return;
  for (const element of binding.elements) {
    if (element.name === undefined) continue;
    const property = element.propertyName ?? element.name;
    const name = isIdentifier(property) ? property.text : undefined;
    if (name !== undefined) reportRaw(name, node, context);
    inspectBinding(element.name, node, context);
  }
}

function memberName(
  expression:
    | import("typescript/unstable/ast").PropertyAccessExpression
    | import("typescript/unstable/ast").ElementAccessExpression,
): string | undefined {
  if (isPropertyAccessExpression(expression)) return expression.name.text;
  const argument = expression.argumentExpression;
  return argument !== undefined && isStringLiteral(argument)
    ? argument.text
    : undefined;
}

function reportRaw(name: string, node: Node, context: FlowContext): void {
  const capability = sinkCapability(name, context.config);
  if (capability === undefined) return;
  const code: SecurityFindingCode =
    capability === "execution"
      ? "RAW_EXECUTION_PRIMITIVE"
      : capability === "database"
        ? "RAW_DATABASE_PRIMITIVE"
        : "RAW_NETWORK_PRIMITIVE";
  addFlowFinding(
    code,
    node,
    `Raw ${capability} primitive ${name} is forbidden; use a capability-matched secure interface.`,
    [flowPoint(node, context, `raw-${capability}-reference`)],
    context,
  );
}
