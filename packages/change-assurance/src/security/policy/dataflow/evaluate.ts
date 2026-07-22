// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type Expression,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import {
  callIdentity,
  type FlowContext,
  type FlowTracePoint,
  flowPoint,
  isFlowExpression,
  trustedCall,
  trustedSanitizer,
} from "../flow.ts";
import type { LocationEnvironment } from "./locations.ts";
import { locationValues } from "./locations.ts";

export interface Taint {
  readonly tainted: boolean;
  readonly trace: readonly FlowTracePoint[];
}

export type TaintEnvironment = LocationEnvironment<Taint>;

export const clean: Taint = Object.freeze({
  tainted: false,
  trace: Object.freeze([]),
});

export function evaluate(
  expression: Expression,
  environment: TaintEnvironment,
  context: FlowContext,
): Taint {
  if (isIdentifier(expression)) {
    if (expression.text === "undefined") return clean;
    return environment.values.get(expression.text) ?? clean;
  }
  if (
    isStringLiteral(expression) ||
    isNumericLiteral(expression) ||
    isNoSubstitutionTemplateLiteral(expression) ||
    expression.kind === SyntaxKind.TrueKeyword ||
    expression.kind === SyntaxKind.FalseKeyword ||
    expression.kind === SyntaxKind.NullKeyword
  )
    return clean;
  if (isParenthesizedExpression(expression) || isAwaitExpression(expression))
    return evaluate(expression.expression, environment, context);
  if (isPropertyAccessExpression(expression)) {
    if (
      expression.expression.getText(context.source.sourceFile) === "process.env"
    )
      return taintedAt(expression, context, "environment-source");
    return combine([
      evaluate(expression.expression, environment, context),
      ...locationValues(expression, environment),
    ]);
  }
  if (isElementAccessExpression(expression)) {
    const base = evaluate(expression.expression, environment, context);
    const argument =
      expression.argumentExpression === undefined
        ? clean
        : evaluate(expression.argumentExpression, environment, context);
    return combine([
      base,
      argument,
      ...locationValues(expression, environment),
    ]);
  }
  if (isBinaryExpression(expression))
    return combine([
      evaluate(expression.left, environment, context),
      evaluate(expression.right, environment, context),
    ]);
  if (isConditionalExpression(expression))
    return combine([
      evaluate(expression.condition, environment, context),
      evaluate(expression.whenTrue, environment, context),
      evaluate(expression.whenFalse, environment, context),
    ]);
  if (isTemplateExpression(expression))
    return combine(
      expression.templateSpans.map((span) =>
        evaluate(span.expression, environment, context),
      ),
    );
  if (isArrayLiteralExpression(expression))
    return combine(
      expression.elements.map((element) =>
        evaluate(element as Expression, environment, context),
      ),
    );
  if (isObjectLiteralExpression(expression))
    return combine(
      expression.properties.flatMap((property) =>
        isPropertyAssignment(property)
          ? [evaluate(property.initializer, environment, context)]
          : [],
      ),
    );
  if (isCallExpression(expression)) {
    const identity = callIdentity(expression, context.source);
    if (trustedSanitizer(identity, context)) return clean;
    const argumentsTaint = combine(
      expression.arguments.map((argument) =>
        evaluate(argument, environment, context),
      ),
    );
    if (argumentsTaint.tainted)
      return append(
        argumentsTaint,
        flowPoint(expression, context, "call-result"),
      );
    if (trustedCall(identity, context)) return clean;
    return taintedAt(expression, context, "unresolved-call-result");
  }
  let result = clean;
  expression.forEachChild((child) => {
    if (isFlowExpression(child))
      result = combine([result, evaluate(child, environment, context)]);
  });
  return result;
}

export function taintedAt(
  node: Node,
  context: FlowContext,
  kind: string,
): Taint {
  return Object.freeze({
    tainted: true,
    trace: Object.freeze([flowPoint(node, context, kind)]),
  });
}

export function combine(values: readonly Taint[]): Taint {
  const tainted = values.filter((value) => value.tainted);
  return tainted.length === 0
    ? clean
    : Object.freeze({
        tainted: true,
        trace: Object.freeze(
          tainted.flatMap(({ trace }) => trace).slice(0, 32),
        ),
      });
}

export function mergeEnvironments(
  target: TaintEnvironment,
  left: TaintEnvironment,
  right: TaintEnvironment,
): void {
  for (const name of new Set([...left.values.keys(), ...right.values.keys()])) {
    target.values.set(
      name,
      combine([
        left.values.get(name) ?? clean,
        right.values.get(name) ?? clean,
      ]),
    );
  }
  for (const name of new Set([
    ...left.aliases.keys(),
    ...right.aliases.keys(),
  ])) {
    const leftAlias = left.aliases.get(name);
    if (leftAlias !== undefined && leftAlias === right.aliases.get(name))
      target.aliases.set(name, leftAlias);
    else target.aliases.set(name, name);
  }
}

export function bindTaint(
  name: Node,
  taint: Taint,
  environment: TaintEnvironment,
): void {
  if (isIdentifier(name)) {
    environment.values.set(name.text, taint);
    if (!environment.aliases.has(name.text))
      environment.aliases.set(name.text, name.text);
    return;
  }
  if (!(isObjectBindingPattern(name) || isArrayBindingPattern(name))) return;
  for (const element of name.elements) {
    if ("name" in element) bindTaint(element.name, taint, environment);
  }
}

function append(taint: Taint, point: FlowTracePoint): Taint {
  return taint.tainted
    ? Object.freeze({
        tainted: true,
        trace: Object.freeze([...taint.trace, point]),
      })
    : clean;
}
