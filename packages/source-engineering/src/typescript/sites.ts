// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes the AST through an unstable package export.
import {
  isArrowFunction,
  isBinaryExpression,
  isCaseClause,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isConstructorDeclaration,
  isDoStatement,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIfStatement,
  isMethodDeclaration,
  isPrefixUnaryExpression,
  isReturnStatement,
  isSetAccessorDeclaration,
  isStatement,
  isWhileStatement,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import { type Digest, digestText } from "../digest.ts";
import type {
  ExecutableVersionEvidence,
  MutationSiteEvidence,
  MutationVariantEvidence,
} from "../evidence/structural-contract.ts";

export function analyzeExecutableVersion(
  node: Node,
  nodeId: Digest,
): ExecutableVersionEvidence {
  return analyzeRegion(Object.freeze([node]), nodeId, true);
}

export function analyzeExecutableRegion(
  nodes: readonly Node[],
  nodeId: Digest,
): ExecutableVersionEvidence {
  return analyzeRegion(nodes, nodeId, false);
}

function analyzeRegion(
  nodes: readonly Node[],
  nodeId: Digest,
  traverseExecutableRoots: boolean,
): ExecutableVersionEvidence {
  if (nodes.length === 0) {
    throw new Error("executable regions require at least one AST node");
  }
  const branches: Digest[] = [];
  const sites: MutationSiteEvidence[] = [];
  const projection: string[] = [];
  const roots = new Set(nodes);
  const walk = (current: Node, route: string): void => {
    if (
      executableBoundary(current) &&
      (!roots.has(current) || !traverseExecutableRoots)
    ) {
      return;
    }
    projection.push(String(current.kind));
    const branch = branchDescriptor(current);
    if (branch !== undefined) {
      const branchId = digestText(
        JSON.stringify({ nodeId, route, branch: branch.operator }),
      );
      branches.push(branchId);
      sites.push(
        mutationSite(
          nodeId,
          route,
          "condition",
          branch.operator,
          branch.node,
          branchId,
        ),
      );
    }
    if (isBinaryExpression(current)) {
      const operator = syntaxName(current.operatorToken.kind);
      if (
        operator !== undefined &&
        mutableBinaryOperator(current.operatorToken.kind)
      ) {
        sites.push(
          mutationSite(
            nodeId,
            route,
            boundaryOperator(current.operatorToken.kind)
              ? "boundary"
              : "operator",
            operator,
            current.operatorToken,
          ),
        );
      }
    } else if (
      isPrefixUnaryExpression(current) &&
      (current.operator === SyntaxKind.ExclamationToken ||
        current.operator === SyntaxKind.PlusPlusToken ||
        current.operator === SyntaxKind.MinusMinusToken)
    ) {
      sites.push(
        mutationSite(
          nodeId,
          route,
          "operator",
          syntaxName(current.operator) ?? String(current.operator),
          current,
        ),
      );
    } else if (isReturnStatement(current)) {
      sites.push(mutationSite(nodeId, route, "return", "return", current));
    }
    let childIndex = 0;
    let childCount = 0;
    current.forEachChild((child) => {
      childCount += 1;
      const childRoute = `${route}.${childIndex}`;
      childIndex += 1;
      walk(child, childRoute);
    });
    if (childCount === 0) projection.push(current.getText());
    projection.push(";");
  };
  nodes.forEach((node, index) => {
    walk(node, String(index));
  });
  const branchIds = Object.freeze([...new Set(branches)].sort());
  const mutationSites = Object.freeze(
    [...new Map(sites.map((site) => [site.siteId, site])).values()].sort(
      (left, right) => left.siteId.localeCompare(right.siteId),
    ),
  );
  const span = Object.freeze({
    start: Math.min(...nodes.map((node) => node.getStart())),
    end: Math.max(...nodes.map(({ end }) => end)),
  });
  const lineIds = executableLineIds(nodes, nodeId, traverseExecutableRoots);
  const material = {
    nodeDigest: digestText(projection.join("\0")),
    span,
    lineIds,
    complexity: 1 + branchIds.length,
    branchIds,
    mutationSites,
  };
  return Object.freeze({
    ...material,
    versionDigest: digestText(
      JSON.stringify({ metricVersion: "cyclomatic-v1", ...material }),
    ),
  });
}

function executableBoundary(node: Node): boolean {
  return (
    executableFunction(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node)
  );
}

function executableLineIds(
  nodes: readonly Node[],
  nodeId: Digest,
  functionVersion: boolean,
): readonly Digest[] {
  const lines = new Set<number>();
  const roots = functionVersion ? nodes.flatMap(functionExecutionRoots) : nodes;
  const visit = (node: Node): void => {
    if (executableBoundary(node)) return;
    if (
      node.kind !== SyntaxKind.Block &&
      node.kind !== SyntaxKind.EmptyStatement &&
      (isStatement(node) || isExpression(node))
    ) {
      lines.add(
        node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
          .line,
      );
    }
    node.forEachChild(visit);
  };
  for (const root of roots) {
    if (!functionVersion || executableBoundary(root)) {
      lines.add(
        root.getSourceFile().getLineAndCharacterOfPosition(root.getStart())
          .line,
      );
    }
    visit(root);
  }
  return Object.freeze(
    [...lines]
      .map((line) => digestText(JSON.stringify({ nodeId, line })))
      .sort((left, right) => left.localeCompare(right)),
  );
}

function functionExecutionRoots(node: Node): readonly Node[] {
  if (isFunctionDeclaration(node) && node.body !== undefined) {
    return executionRoots(node.parameters, node.body);
  }
  if (isMethodDeclaration(node) && node.body !== undefined) {
    return executionRoots(node.parameters, node.body);
  }
  if (isConstructorDeclaration(node) && node.body !== undefined) {
    return executionRoots(node.parameters, node.body);
  }
  if (isGetAccessorDeclaration(node) && node.body !== undefined) {
    return executionRoots(node.parameters, node.body);
  }
  if (isSetAccessorDeclaration(node) && node.body !== undefined) {
    return executionRoots(node.parameters, node.body);
  }
  if (isFunctionExpression(node) || isArrowFunction(node)) {
    return executionRoots(node.parameters, node.body);
  }
  return Object.freeze([]);
}

function executionRoots(
  parameters: readonly Readonly<{ initializer?: Node }>[],
  body: Node,
): readonly Node[] {
  return Object.freeze([
    ...parameters.flatMap(({ initializer }) =>
      initializer === undefined ? [] : [initializer],
    ),
    body,
  ]);
}

function executableFunction(node: Node): boolean {
  return (
    (isFunctionDeclaration(node) && node.body !== undefined) ||
    (isMethodDeclaration(node) && node.body !== undefined) ||
    (isConstructorDeclaration(node) && node.body !== undefined) ||
    (isGetAccessorDeclaration(node) && node.body !== undefined) ||
    (isSetAccessorDeclaration(node) && node.body !== undefined) ||
    isFunctionExpression(node) ||
    isArrowFunction(node)
  );
}

function branchDescriptor(
  node: Node,
): Readonly<{ operator: string; node: Node }> | undefined {
  if (isIfStatement(node)) return { operator: "if", node: node.expression };
  if (isWhileStatement(node))
    return { operator: "while", node: node.expression };
  if (isDoStatement(node))
    return { operator: "do-while", node: node.expression };
  if (isForStatement(node)) {
    return node.condition === undefined
      ? undefined
      : { operator: "for", node: node.condition };
  }
  if (isForInStatement(node))
    return { operator: "for-in", node: node.expression };
  if (isForOfStatement(node))
    return { operator: "for-of", node: node.expression };
  if (isCatchClause(node)) return { operator: "catch", node };
  if (isConditionalExpression(node)) {
    return { operator: "conditional", node: node.condition };
  }
  if (isCaseClause(node)) return { operator: "case", node: node.expression };
  if (isBinaryExpression(node) && logicalOperator(node.operatorToken.kind)) {
    return {
      operator: syntaxName(node.operatorToken.kind) ?? "logical",
      node: node.operatorToken,
    };
  }
  return;
}

function logicalOperator(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.AmpersandAmpersandToken ||
    kind === SyntaxKind.BarBarToken ||
    kind === SyntaxKind.QuestionQuestionToken ||
    kind === SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === SyntaxKind.BarBarEqualsToken ||
    kind === SyntaxKind.QuestionQuestionEqualsToken
  );
}

function mutableBinaryOperator(kind: SyntaxKind): boolean {
  return (
    logicalOperator(kind) ||
    (kind >= SyntaxKind.LessThanToken &&
      kind <= SyntaxKind.ExclamationEqualsEqualsToken) ||
    (kind >= SyntaxKind.PlusToken && kind <= SyntaxKind.PercentToken)
  );
}

function boundaryOperator(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.LessThanToken ||
    kind === SyntaxKind.LessThanEqualsToken ||
    kind === SyntaxKind.GreaterThanToken ||
    kind === SyntaxKind.GreaterThanEqualsToken
  );
}

function syntaxName(kind: SyntaxKind): string | undefined {
  const value: unknown = SyntaxKind[kind];
  return typeof value === "string" ? value : undefined;
}

function mutationSite(
  nodeId: Digest,
  route: string,
  kind: MutationSiteEvidence["kind"],
  operator: string,
  node: Node,
  branchId?: Digest,
): MutationSiteEvidence {
  const material = { nodeId, route, kind, operator };
  const siteId = digestText(JSON.stringify(material));
  return Object.freeze({
    siteId,
    kind,
    operator,
    span: spanOf(node),
    variants: variantsFor(siteId, kind, operator),
    ...(branchId === undefined ? {} : { branchId }),
  });
}

function variantsFor(
  siteId: Digest,
  kind: MutationSiteEvidence["kind"],
  operator: string,
): readonly MutationVariantEvidence[] {
  const replacements = replacementsFor(kind, operator);
  return Object.freeze(
    replacements.map((replacement) =>
      Object.freeze({
        variantId: digestText(JSON.stringify({ siteId, replacement })),
        replacement,
      }),
    ),
  );
}

function replacementsFor(
  kind: MutationSiteEvidence["kind"],
  operator: string,
): readonly string[] {
  if (kind === "condition") return ["force-false", "force-true"];
  if (kind === "return") return ["remove-return", "replace-return"];
  const opposite: Readonly<Record<string, string>> = Object.freeze({
    LessThanToken: "LessThanEqualsToken",
    LessThanEqualsToken: "LessThanToken",
    GreaterThanToken: "GreaterThanEqualsToken",
    GreaterThanEqualsToken: "GreaterThanToken",
    EqualsEqualsToken: "ExclamationEqualsToken",
    ExclamationEqualsToken: "EqualsEqualsToken",
    EqualsEqualsEqualsToken: "ExclamationEqualsEqualsToken",
    ExclamationEqualsEqualsToken: "EqualsEqualsEqualsToken",
    AmpersandAmpersandToken: "BarBarToken",
    BarBarToken: "AmpersandAmpersandToken",
    QuestionQuestionToken: "BarBarToken",
    PlusToken: "MinusToken",
    MinusToken: "PlusToken",
    AsteriskToken: "SlashToken",
    SlashToken: "AsteriskToken",
    PercentToken: "AsteriskToken",
    ExclamationToken: "identity",
    PlusPlusToken: "MinusMinusToken",
    MinusMinusToken: "PlusPlusToken",
  });
  return [opposite[operator] ?? "operator-alternative"];
}

function spanOf(node: Node) {
  return Object.freeze({ start: node.getStart(), end: node.end });
}
