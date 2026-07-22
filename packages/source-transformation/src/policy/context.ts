// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  isAsExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isSatisfiesExpression,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import type {
  ChangedNodeContext,
  ParsedPolicyChange,
  PolicyFinding,
  PolicyFindingCode,
} from "./contract.ts";

export interface PolicyRuleContext extends ChangedNodeContext {
  readonly findings: PolicyFinding[];
}

export function createRuleContext(
  change: ParsedPolicyChange,
): PolicyRuleContext {
  return {
    change,
    changedNodes: findChangedNodes(change.baseline, change.candidate),
    findings: [],
  };
}

export function visitChangedNodes(
  context: PolicyRuleContext,
  visitor: (node: Node) => void,
): void {
  visitNodes(context.change.candidate, (node) => {
    if (context.changedNodes.has(node)) {
      visitor(node);
    }
  });
}

export function visitNodes(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  node.forEachChild((child) => {
    visitNodes(child, visitor);
  });
}

export function addNodeFinding(
  context: PolicyRuleContext,
  node: Node,
  code: PolicyFindingCode,
  message: string,
): void {
  context.findings.push({
    path: context.change.path,
    start: safeStart(node, context.change.candidate),
    end: safeEnd(node),
    code,
    message,
  });
}

export function identifierText(node: Node | undefined): string | undefined {
  return node !== undefined && isIdentifier(node) ? node.text : undefined;
}

export function propertyNameText(node: Node | undefined): string | undefined {
  if (node === undefined) {
    return;
  }
  if (isIdentifier(node) || isStringLiteral(node)) {
    return node.text;
  }
  return;
}

export function unwrapExpression(node: Node): Node {
  let current = node;
  while (
    isParenthesizedExpression(current) ||
    isSatisfiesExpression(current) ||
    isAsExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function primitiveLiteral(
  node: Node,
): { readonly key: string; readonly value: string | number } | undefined {
  const current = unwrapExpression(node);
  if (isStringLiteral(current) || isNoSubstitutionTemplateLiteral(current)) {
    return { key: `string:${current.text}`, value: current.text };
  }
  if (isNumericLiteral(current)) {
    const value = Number(current.text.replaceAll("_", ""));
    return Number.isFinite(value)
      ? { key: `number:${value}`, value }
      : undefined;
  }
  if (
    isPrefixUnaryExpression(current) &&
    current.operator === SyntaxKind.MinusToken &&
    isNumericLiteral(current.operand)
  ) {
    const value = -Number(current.operand.text.replaceAll("_", ""));
    return Number.isFinite(value)
      ? { key: `number:${value}`, value }
      : undefined;
  }
  return;
}

export function hasAncestor(
  node: Node,
  predicate: (ancestor: Node) => boolean,
): boolean {
  let current: Node | undefined = node.parent;
  while (current !== undefined) {
    if (predicate(current)) {
      return true;
    }
    if (current.kind === SyntaxKind.SourceFile) {
      break;
    }
    current = current.parent;
  }
  return false;
}

function findChangedNodes(
  baseline: SourceFile | null,
  candidate: SourceFile,
): ReadonlySet<object> {
  if (baseline === null) {
    const all = new Set<object>();
    visitNodes(candidate, (node) => {
      all.add(node);
    });
    return all;
  }

  const baselineCounts = new Map<string, number>();
  visitNodes(baseline, (node) => {
    const fingerprint = nodeFingerprint(node, baseline);
    baselineCounts.set(fingerprint, (baselineCounts.get(fingerprint) ?? 0) + 1);
  });

  const changed = new Set<object>();
  visitNodes(candidate, (node) => {
    const fingerprint = nodeFingerprint(node, candidate);
    const remaining = baselineCounts.get(fingerprint) ?? 0;
    if (remaining === 0) {
      changed.add(node);
    } else {
      baselineCounts.set(fingerprint, remaining - 1);
    }
  });
  return changed;
}

function nodeFingerprint(node: Node, sourceFile: SourceFile): string {
  return `${node.kind}\u0000${node.getText(sourceFile)}`;
}

function safeStart(node: Node, sourceFile: SourceFile): number {
  const start = node.getStart(sourceFile);
  return Number.isSafeInteger(start) && start >= 0 ? start : 0;
}

function safeEnd(node: Node): number {
  const end = node.getEnd();
  return Number.isSafeInteger(end) && end >= 0 ? end : 0;
}
