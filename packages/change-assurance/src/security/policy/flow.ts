// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import type {
  ParsedSecuritySource,
  SecurityFinding,
  SecurityFindingCode,
  SecurityPolicyConfig,
} from "../contract.ts";
import { finding } from "./analysis/receipts.ts";
import { sanitizerNames } from "./analysis/rules.ts";

export interface FlowTracePoint {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly kind: string;
}

export interface FlowContext {
  readonly source: ParsedSecuritySource;
  readonly config: SecurityPolicyConfig;
  readonly findings: SecurityFinding[];
  readonly findingKeys: Set<string>;
}

const defaultSinks = new Map<string, "execution" | "database" | "network">([
  ["exec", "execution"],
  ["execFile", "execution"],
  ["spawn", "execution"],
  ["spawnSync", "execution"],
  ["runCommand", "execution"],
  ["query", "database"],
  ["execute", "database"],
  ["executeQuery", "database"],
  ["rawQuery", "database"],
  ["unsafeQuery", "database"],
  ["fetch", "network"],
  ["request", "network"],
  ["sendRequest", "network"],
  ["axios", "network"],
]);

export function trustedSanitizer(
  identity: ReturnType<typeof callIdentity>,
  context: FlowContext,
): boolean {
  return (
    sanitizerNames.has(identity.semanticName) && trustedCall(identity, context)
  );
}

export function trustedCall(
  identity: ReturnType<typeof callIdentity>,
  context: FlowContext,
): boolean {
  const binding = context.source.importBindings.get(identity.bindingName);
  if (binding === undefined) return false;
  const imported =
    identity.semanticName === "*" ? binding.imported : identity.semanticName;
  const audit = context.config.auditedImports.find(
    ({ module }) => module === binding.module,
  );
  if (
    audit !== undefined &&
    (audit.allowedImports.includes(imported) ||
      audit.allowedImports.includes("*"))
  )
    return true;
  return context.config.secureInterfaces.some(
    ({ module, imports }) =>
      module === binding.module &&
      (imports.includes(imported) || imports.includes("*")),
  );
}

export function callIdentity(
  call: CallExpression,
  source: ParsedSecuritySource,
): Readonly<{
  localName: string;
  bindingName: string;
  semanticName: string;
  dynamic: boolean;
}> {
  if (isIdentifier(call.expression)) {
    const localName = call.expression.text;
    return {
      localName,
      bindingName: localName,
      semanticName: source.importAliases.get(localName) ?? localName,
      dynamic: false,
    };
  }
  if (isPropertyAccessExpression(call.expression)) {
    const bindingName = isIdentifier(call.expression.expression)
      ? call.expression.expression.text
      : "";
    return {
      localName: call.expression.name.text,
      bindingName,
      semanticName: call.expression.name.text,
      dynamic: false,
    };
  }
  if (
    isElementAccessExpression(call.expression) &&
    isStringLiteral(call.expression.argumentExpression)
  ) {
    const localName = call.expression.argumentExpression.text;
    const bindingName = isIdentifier(call.expression.expression)
      ? call.expression.expression.text
      : "";
    return {
      localName,
      bindingName,
      semanticName: localName,
      dynamic: false,
    };
  }
  return {
    localName: "<dynamic>",
    bindingName: "",
    semanticName: "<dynamic>",
    dynamic: true,
  };
}

export function sinkCapability(
  name: string,
  config: SecurityPolicyConfig,
): "execution" | "database" | "network" | undefined {
  for (const rule of config.sinks) {
    if (rule.names.includes(name)) return rule.capability;
  }
  return defaultSinks.get(name);
}

export function addFlowFinding(
  code: SecurityFindingCode,
  node: Node,
  message: string,
  trace: readonly FlowTracePoint[],
  context: FlowContext,
): void {
  const location = flowPoint(node, context, "finding");
  const key = `${code}\0${context.source.path}\0${location.line}\0${location.column}`;
  if (context.findingKeys.has(key)) return;
  context.findingKeys.add(key);
  context.findings.push(
    finding(
      code,
      context.source.path,
      message,
      location.line,
      location.column,
      Object.freeze(trace),
    ),
  );
}

export function flowPoint(
  node: Node,
  context: FlowContext,
  kind: string,
): FlowTracePoint {
  const location = context.source.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(context.source.sourceFile),
  );
  return Object.freeze({
    path: context.source.path,
    line: location.line + 1,
    column: location.character + 1,
    kind,
  });
}

export function visitFlowNodes(
  node: Node,
  visitor: (node: Node) => void,
): void {
  visitor(node);
  node.forEachChild((child) => visitFlowNodes(child, visitor));
}

export function isFlowExpression(node: Node): node is Expression {
  return (
    node.kind >= SyntaxKind.ThisKeyword &&
    node.kind <= SyntaxKind.JsxNamespacedName
  );
}
