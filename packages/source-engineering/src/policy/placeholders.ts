// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  createScanner,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isMethodDeclaration,
  isNewExpression,
  isStringLiteral,
  isThrowStatement,
  type Node,
  SyntaxKind,
  type ThrowStatement,
} from "typescript/unstable/ast";
import {
  addNodeFinding,
  identifierText,
  type PolicyRuleContext,
  propertyNameText,
  visitChangedNodes,
} from "./context.ts";

const PLACEHOLDER_PATTERN = /\b(?:fixme|placeholder|tbd|todo|xxx)\b/iu;
const STUB_THROW_PATTERN =
  /\b(?:fixme|not[\s_-]*implemented|placeholder|tbd|todo)\b/iu;

export function inspectPlaceholders(context: PolicyRuleContext): void {
  inspectPlaceholderComments(context);
  visitChangedNodes(context, (node) => {
    if (isThrowStatement(node) && isStubThrow(node)) {
      addNodeFinding(
        context,
        node,
        "STUB_THROW",
        "Replace stub throws with a real failure contract before production code is admitted.",
      );
    }
    if (isEmptyNamedConcreteBody(node)) {
      addNodeFinding(
        context,
        node,
        "EMPTY_NAMED_BODY",
        "Named concrete functions and methods must have observable behavior.",
      );
    }
  });
}

function inspectPlaceholderComments(context: PolicyRuleContext): void {
  const baselineComments = countComments(context.change.baselineText ?? "");
  const scanner = createScanner(
    false,
    context.change.candidate.languageVariant,
    context.change.candidateText,
  );
  for (
    let token = scanner.scan();
    token !== SyntaxKind.EndOfFile;
    token = scanner.scan()
  ) {
    if (
      token !== SyntaxKind.SingleLineCommentTrivia &&
      token !== SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const text = scanner.getTokenText();
    const remaining = baselineComments.get(text) ?? 0;
    if (remaining > 0) {
      baselineComments.set(text, remaining - 1);
      continue;
    }
    if (!PLACEHOLDER_PATTERN.test(text)) {
      continue;
    }
    context.findings.push({
      path: context.change.path,
      start: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
      code: "PLACEHOLDER_COMMENT",
      message: "Placeholder comments are not executable completion evidence.",
    });
  }
}

function countComments(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const scanner = createScanner(false, undefined, text);
  for (
    let token = scanner.scan();
    token !== SyntaxKind.EndOfFile;
    token = scanner.scan()
  ) {
    if (
      token === SyntaxKind.SingleLineCommentTrivia ||
      token === SyntaxKind.MultiLineCommentTrivia
    ) {
      const comment = scanner.getTokenText();
      counts.set(comment, (counts.get(comment) ?? 0) + 1);
    }
  }
  return counts;
}

function isStubThrow(node: ThrowStatement): boolean {
  const { expression } = node;
  if (isStringLiteral(expression)) {
    return STUB_THROW_PATTERN.test(expression.text);
  }
  if (
    (isNewExpression(expression) || isCallExpression(expression)) &&
    identifierText(expression.expression) === "Error"
  ) {
    const message = expression.arguments?.[0];
    return message !== undefined && isStringLiteral(message)
      ? STUB_THROW_PATTERN.test(message.text)
      : false;
  }
  return false;
}

function isEmptyNamedConcreteBody(node: Node): boolean {
  if (isFunctionDeclaration(node)) {
    return (
      node.name !== undefined &&
      node.body !== undefined &&
      node.body.statements.length === 0
    );
  }
  if (isFunctionExpression(node)) {
    return node.name !== undefined && node.body.statements.length === 0;
  }
  if (isMethodDeclaration(node)) {
    return (
      propertyNameText(node.name) !== undefined &&
      node.body !== undefined &&
      node.body.statements.length === 0 &&
      !node.modifiers?.some(
        (modifier) =>
          modifier.kind === SyntaxKind.AbstractKeyword ||
          modifier.kind === SyntaxKind.DeclareKeyword,
      )
    );
  }
  return false;
}
