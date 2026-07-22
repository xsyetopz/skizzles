// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type CallExpression,
  isArrowFunction,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from "typescript/unstable/ast";
import type {
  ParsedSecuritySource,
  SecurityPolicyConfig,
} from "../../contract.ts";

export interface DominanceCallIdentity {
  readonly binding: string;
  readonly name: string;
}

export function dominanceCallIdentity(
  call: CallExpression,
  source: ParsedSecuritySource,
): DominanceCallIdentity {
  if (isIdentifier(call.expression)) {
    const local = call.expression.text;
    return {
      binding: local,
      name: source.importAliases.get(local) ?? local,
    };
  }
  if (isPropertyAccessExpression(call.expression))
    return {
      binding: isIdentifier(call.expression.expression)
        ? call.expression.expression.text
        : "",
      name: call.expression.name.text,
    };
  return { binding: "", name: "<dynamic>" };
}

export function trustedDominanceCall(
  identity: DominanceCallIdentity,
  source: ParsedSecuritySource,
  config: SecurityPolicyConfig,
): boolean {
  const binding = source.importBindings.get(identity.binding);
  if (binding === undefined) return false;
  const audit = config.auditedImports.find(
    ({ module }) => module === binding.module,
  );
  return (
    (audit?.allowedImports.includes(identity.name) ?? false) ||
    config.secureInterfaces.some(
      ({ module, imports }) =>
        module === binding.module && imports.includes(identity.name),
    )
  );
}

export function visitDominanceNodes(
  node: Node,
  visitor: (node: Node) => void,
): void {
  visitor(node);
  node.forEachChild((child) => visitDominanceNodes(child, visitor));
}

export function visitSkippingNestedFunctions(
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
    visitSkippingNestedFunctions(child, visitor);
  });
}
