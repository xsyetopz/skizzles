// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  type CatchClause,
  isCatchClause,
  isExpressionStatement,
  isIdentifier,
  isVoidExpression,
  type Node,
} from "typescript/unstable/ast";
import {
  addNodeFinding,
  type PolicyRuleContext,
  visitChangedNodes,
  visitNodes,
} from "./context.ts";

export function inspectCatches(context: PolicyRuleContext): void {
  visitChangedNodes(context, (node) => {
    if (!isCatchClause(node)) {
      return;
    }
    if (node.block.statements.length === 0) {
      addNodeFinding(
        context,
        node.block,
        "EMPTY_CATCH",
        "Catch blocks must map the failure, report it, or deliberately rethrow it.",
      );
    }
    if (
      node.variableDeclaration !== undefined &&
      !catchBindingIsMeaningfullyUsed(node)
    ) {
      addNodeFinding(
        context,
        node.variableDeclaration,
        "UNUSED_CATCH_BINDING",
        "A bound catch value must participate in failure handling.",
      );
    }
  });
}

function catchBindingIsMeaningfullyUsed(clause: CatchClause): boolean {
  const names = new Set<string>();
  visitNodes(clause.variableDeclaration?.name ?? clause, (node) => {
    if (isIdentifier(node)) {
      names.add(node.text);
    }
  });
  if (names.size === 0) {
    return false;
  }

  const meaningfulUses = new Set<Node>();
  visitNodes(clause.block, (node) => {
    if (
      meaningfulUses.size === 0 &&
      isIdentifier(node) &&
      names.has(node.text) &&
      isMeaningful(node)
    ) {
      meaningfulUses.add(node);
    }
  });
  return meaningfulUses.size > 0;
}

function isMeaningful(node: Node): boolean {
  const parent = node.parent;
  if (isVoidExpression(parent)) {
    return false;
  }
  return !isExpressionStatement(parent);
}
