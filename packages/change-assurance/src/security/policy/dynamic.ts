// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type CallExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { resolveSinkDispatch, type SinkAliases } from "./dataflow/dispatch.ts";
import {
  addFlowFinding,
  type FlowContext,
  flowPoint,
  visitFlowNodes,
} from "./flow.ts";

const sensitiveGlobals = new Set(["Bun", "globalThis", "process", "Reflect"]);

export function inspectDynamicResolution(
  sourceFile: SourceFile,
  context: FlowContext,
  aliases: SinkAliases,
): void {
  visitFlowNodes(sourceFile, (node) => {
    if (!isCallExpression(node)) return;
    if (
      resolveSinkDispatch(node, context.source, context.config, aliases)
        .dynamic &&
      reflectiveCall(node)
    ) {
      reject(
        node,
        "dynamic-reflective-dispatch",
        "Unresolved reflective dispatch",
        context,
      );
      return;
    }
    if (node.expression.kind === SyntaxKind.ImportKeyword) {
      reject(node, "dynamic-import", "Dynamic module loading", context);
      return;
    }
    if (
      isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      (node.arguments.length !== 1 ||
        !isStringLiteral(node.arguments[0] as Node))
    ) {
      reject(node, "computed-require", "Computed module loading", context);
      return;
    }
    if (globalElementCall(node)) {
      reject(
        node,
        "global-element-dispatch",
        "Global element dispatch",
        context,
      );
      return;
    }
    if (
      (isIdentifier(node.expression) &&
        (node.expression.text === "eval" ||
          node.expression.text === "Function")) ||
      (isElementAccessExpression(node.expression) &&
        !isStringLiteral(node.expression.argumentExpression as Node))
    )
      reject(
        node,
        "dynamic-dispatch",
        "Computed code or call dispatch",
        context,
      );
  });
}

function reflectiveCall(call: CallExpression): boolean {
  if (isPropertyAccessExpression(call.expression))
    return (
      call.expression.name.text === "apply" ||
      call.expression.name.text === "call" ||
      call.expression.name.text === "bind"
    );
  if (!isElementAccessExpression(call.expression)) return false;
  const argument = call.expression.argumentExpression;
  if (argument === undefined || !isStringLiteral(argument)) return true;
  return (
    argument.text === "apply" ||
    argument.text === "call" ||
    argument.text === "bind"
  );
}

function globalElementCall(call: CallExpression): boolean {
  if (!isElementAccessExpression(call.expression)) return false;
  let current: Node = call.expression.expression;
  while (
    isElementAccessExpression(current) ||
    isPropertyAccessExpression(current)
  )
    current = current.expression;
  return isIdentifier(current) && sensitiveGlobals.has(current.text);
}

function reject(
  call: CallExpression,
  kind: string,
  subject: string,
  context: FlowContext,
): void {
  addFlowFinding(
    "DYNAMIC_SECURITY_DISPATCH",
    call,
    `${subject} is not permitted in security-reviewed candidates.`,
    [flowPoint(call, context, kind)],
    context,
  );
}
