// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclaration,
  type SourceFile,
} from "typescript/unstable/ast";
import type {
  ParsedSecuritySource,
  SecurityPolicyConfig,
} from "../../contract.ts";
import { sinkCapability, visitFlowNodes } from "../flow.ts";

export type SinkCapability = "execution" | "database" | "network";

export interface SinkDispatch {
  readonly capability: SinkCapability | undefined;
  readonly dynamic: boolean;
  readonly raw: boolean;
  readonly semanticName: string;
}

export type SinkAliases = ReadonlyMap<string, SinkDispatch>;

export function collectSinkAliases(
  sourceFile: SourceFile,
  source: ParsedSecuritySource,
  config: SecurityPolicyConfig,
): SinkAliases {
  const aliases = new Map<string, SinkDispatch>();
  const declarations: Array<{
    readonly initializer: Expression;
    readonly name: string;
  }> = [];
  visitFlowNodes(sourceFile, (node) => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      declarations.push({
        initializer: node.initializer,
        name: node.name.text,
      });
    }
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const { initializer, name } of declarations) {
      const dispatch = resolveCallable(initializer, source, config, aliases);
      if (dispatch.capability === undefined || dispatch.dynamic) continue;
      const previous = aliases.get(name);
      if (
        previous?.capability === dispatch.capability &&
        previous.semanticName === dispatch.semanticName
      )
        continue;
      aliases.set(name, dispatch);
      changed = true;
    }
  }
  return aliases;
}

export function resolveSinkDispatch(
  call: CallExpression,
  source: ParsedSecuritySource,
  config: SecurityPolicyConfig,
  aliases: SinkAliases,
): SinkDispatch {
  const reflective = reflectiveTarget(call);
  if (reflective.kind === "dynamic")
    return {
      capability: undefined,
      dynamic: true,
      raw: false,
      semanticName: "<dynamic>",
    };
  const resolved = resolveCallable(
    reflective.kind === "target" ? reflective.target : call.expression,
    source,
    config,
    aliases,
  );
  return reflective.kind === "target" && resolved.capability === undefined
    ? { ...resolved, dynamic: true }
    : resolved;
}

function resolveCallable(
  expression: Expression,
  source: ParsedSecuritySource,
  config: SecurityPolicyConfig,
  aliases: SinkAliases,
): SinkDispatch {
  const unwrapped = unwrap(expression);
  if (isCallExpression(unwrapped)) {
    const bound = reflectiveTarget(unwrapped);
    if (bound.kind === "target")
      return resolveCallable(bound.target, source, config, aliases);
    if (bound.kind === "dynamic")
      return {
        capability: undefined,
        dynamic: true,
        raw: false,
        semanticName: "<dynamic>",
      };
  }
  if (isIdentifier(unwrapped)) {
    const alias = aliases.get(unwrapped.text);
    if (alias !== undefined) return alias;
    const semanticName =
      source.importAliases.get(unwrapped.text) ?? unwrapped.text;
    return {
      capability: sinkCapability(semanticName, config),
      dynamic: false,
      raw: directGlobalSink(unwrapped.text),
      semanticName,
    };
  }
  const member = memberName(unwrapped);
  if (member !== undefined)
    return {
      capability: sinkCapability(member, config),
      dynamic: false,
      raw: rawMember(unwrapped),
      semanticName: member,
    };
  return {
    capability: undefined,
    dynamic: true,
    raw: false,
    semanticName: "<dynamic>",
  };
}

function rawMember(expression: Expression): boolean {
  let current: Expression = expression;
  while (
    isPropertyAccessExpression(current) ||
    isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  return isIdentifier(current) && rawGlobalRoots.has(current.text);
}

function directGlobalSink(name: string): boolean {
  return name === "fetch";
}

function reflectiveTarget(
  call: CallExpression,
):
  | { readonly kind: "none" }
  | { readonly kind: "target"; readonly target: Expression }
  | { readonly kind: "dynamic" } {
  const callee = unwrap(call.expression);
  const member = memberName(callee);
  if (member === "apply" && isReflectObject(memberBase(callee))) {
    const target = call.arguments[0];
    return target === undefined
      ? { kind: "dynamic" }
      : { kind: "target", target };
  }
  if (member === "apply" || member === "call" || member === "bind") {
    const target = memberBase(callee);
    return target === undefined
      ? { kind: "dynamic" }
      : { kind: "target", target };
  }
  if (isReflectObject(memberBase(callee)) && member === undefined)
    return { kind: "dynamic" };
  return { kind: "none" };
}

function memberName(expression: Expression): string | undefined {
  if (isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    isElementAccessExpression(expression) &&
    expression.argumentExpression !== undefined &&
    isStringLiteral(expression.argumentExpression)
  )
    return expression.argumentExpression.text;
  return undefined;
}

function memberBase(expression: Expression): Expression | undefined {
  if (
    isPropertyAccessExpression(expression) ||
    isElementAccessExpression(expression)
  )
    return expression.expression;
  return undefined;
}

function isReflectObject(expression: Expression | undefined): boolean {
  return (
    expression !== undefined &&
    isIdentifier(expression) &&
    expression.text === "Reflect"
  );
}

function unwrap(expression: Expression): Expression {
  let current = expression;
  while (isParenthesizedExpression(current)) current = current.expression;
  return current;
}

const rawGlobalRoots = new Set(["Bun", "globalThis", "process"]);
