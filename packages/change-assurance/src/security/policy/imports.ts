// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isNamedImports,
  isNamespaceImport,
  isStringLiteral,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";

type ImportBinding = Readonly<{
  readonly module: string;
  readonly imported: string;
}>;

export function collectSecurityImport(
  node: Node,
  imports: Map<string, readonly string[]>,
  aliases: Map<string, string>,
  bindings: Map<string, ImportBinding>,
): void {
  if (isImportDeclaration(node)) {
    collectDeclaration(node, imports, aliases, bindings);
  } else if (isImportEqualsDeclaration(node)) {
    collectEquals(node, imports, aliases, bindings);
  }
}

function collectDeclaration(
  node: import("typescript/unstable/ast").ImportDeclaration,
  imports: Map<string, readonly string[]>,
  aliases: Map<string, string>,
  importBindings: Map<string, ImportBinding>,
): void {
  if (!isStringLiteral(node.moduleSpecifier)) return;
  const moduleName = node.moduleSpecifier.text;
  const names: string[] = [];
  const clause = node.importClause;
  if (clause?.name !== undefined) {
    names.push("default");
    aliases.set(clause.name.text, "default");
    importBindings.set(
      clause.name.text,
      Object.freeze({ module: moduleName, imported: "default" }),
    );
  }
  const bindings = clause?.namedBindings;
  if (bindings === undefined) {
    imports.set(moduleName, Object.freeze(names));
    return;
  }
  if (isNamespaceImport(bindings)) {
    names.push("*");
    aliases.set(bindings.name.text, "*");
    importBindings.set(
      bindings.name.text,
      Object.freeze({ module: moduleName, imported: "*" }),
    );
  }
  if (isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (!isImportSpecifier(element)) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      names.push(imported);
      aliases.set(element.name.text, imported);
      importBindings.set(
        element.name.text,
        Object.freeze({ module: moduleName, imported }),
      );
    }
  }
  imports.set(moduleName, Object.freeze(names));
}

function collectEquals(
  node: import("typescript/unstable/ast").ImportEqualsDeclaration,
  imports: Map<string, readonly string[]>,
  aliases: Map<string, string>,
  bindings: Map<string, ImportBinding>,
): void {
  if (node.moduleReference.kind !== SyntaxKind.ExternalModuleReference) return;
  const expression = node.moduleReference.expression;
  if (!isStringLiteral(expression)) return;
  imports.set(expression.text, Object.freeze([node.name.text]));
  aliases.set(node.name.text, node.name.text);
  bindings.set(
    node.name.text,
    Object.freeze({ module: expression.text, imported: "*" }),
  );
}
