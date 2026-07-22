// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  isArrowFunction,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { visitFlowNodes } from "../flow.ts";

type FunctionNode = FunctionDeclaration | ArrowFunction | FunctionExpression;

export interface SecurityFunctionEntry {
  readonly name: string;
  readonly node: FunctionNode;
}

export function collectSecurityFunctions(
  sourceFile: SourceFile,
): SecurityFunctionEntry[] {
  const entries: SecurityFunctionEntry[] = [];
  visitFlowNodes(sourceFile, (node) => {
    if (isFunctionDeclaration(node) && node.name !== undefined) {
      entries.push({ name: node.name.text, node });
      return;
    }
    if (!(isArrowFunction(node) || isFunctionExpression(node))) return;
    const parent = node.parent;
    if (
      parent.kind === SyntaxKind.VariableDeclaration &&
      "name" in parent &&
      isIdentifier(parent.name as Node)
    ) {
      entries.push({
        name: (parent.name as { readonly text: string }).text,
        node,
      });
    }
  });
  return entries;
}

export function visitSkippingFunctions(
  node: Node,
  visitor: (node: Node) => void,
): void {
  visitor(node);
  node.forEachChild((child) => {
    if (
      isFunctionDeclaration(child) ||
      isFunctionExpression(child) ||
      isArrowFunction(child)
    )
      return;
    visitSkippingFunctions(child, visitor);
  });
}
