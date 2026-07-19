// biome-ignore-all lint/correctness/noUnresolvedImports: Biome does not resolve TypeScript 7 unstable package exports.
import {
  isAwaitExpression,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import {
  addFinding,
  type WorkspaceFinding,
  type WorkspacePackage,
} from "../contract.ts";

type TemporaryOwnershipKind =
  | "ambient-temp-env"
  | "hard-coded-host-temp"
  | "mkdtemp"
  | "mkdtempSync"
  | "nested-recursive-disposal"
  | "tmpdir";

interface TemporaryOwnershipUse {
  kind: TemporaryOwnershipKind;
}

interface TemporaryOwnershipDisposition {
  path: string;
  allowedUses: readonly TemporaryOwnershipKind[];
  reason: string;
}

const NODE_FS_MODULES = new Set(["node:fs", "node:fs/promises"]);
const NODE_OS_MODULE = "node:os";
const FORBIDDEN_FS_EXPORTS = new Set(["mkdtemp", "mkdtempSync"]);
const WINDOWS_SEPARATOR_PATTERN = /\\/gu;
const WINDOWS_TEMP_PATTERN = /^[a-z]:\/(?:windows\/)?temp(?:\/|$)/iu;
const POSIX_TEMP_PATTERN = /^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/u;
const AMBIENT_TEMP_NAMES = new Set(["TEMP", "TMP", "TMPDIR"]);

interface NamespaceBinding {
  module: string;
  symbol: unknown;
}

const TEMPORARY_OWNERSHIP_DISPOSITIONS: readonly TemporaryOwnershipDisposition[] =
  [
    disposition(
      packagePath("run-workspace", "src/platform.ts"),
      ["mkdtemp", "tmpdir"],
      "@skizzles/run-workspace is the sole disposable run-root platform authority.",
    ),
    disposition(
      packagePath("container-lab", "src/state/layout.ts"),
      ["tmpdir"],
      "Container Lab state and runtime layout intentionally spans commands and is reaper-owned.",
    ),
    disposition(
      packagePath("command-supervisor", "src/codex-command/settings.ts"),
      ["tmpdir"],
      "Command-supervisor output is bounded retained operational evidence.",
    ),
    disposition(
      packagePath("installer", "src/prompt-policy/lock.ts"),
      ["tmpdir"],
      "The installer prompt-policy lock is a cross-process durable coordination owner.",
    ),
  ] as const;

function scanTemporaryOwnership(
  sourceFile: SourceFile,
): TemporaryOwnershipUse[] {
  const uses = new Set<TemporaryOwnershipKind>();
  const namespaces = new Map<string, NamespaceBinding>();
  const disposers = new Set<string>();
  scanImports(sourceFile, namespaces, disposers, uses);
  scanNodes(sourceFile, namespaces, disposers, uses);
  return [...uses]
    .sort((left, right) => left.localeCompare(right))
    .map((kind) => ({ kind }));
}

function scanImports(
  sourceFile: SourceFile,
  namespaces: Map<string, NamespaceBinding>,
  disposers: Set<string>,
  uses: Set<TemporaryOwnershipKind>,
): void {
  for (const statement of sourceFile.statements) {
    scanImport(statement, namespaces, disposers, uses);
  }
}

function scanImport(
  node: Node,
  namespaces: Map<string, NamespaceBinding>,
  disposers: Set<string>,
  uses: Set<TemporaryOwnershipKind>,
): void {
  if (isImportEqualsDeclaration(node)) {
    if (
      isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      isStringLiteral(node.moduleReference.expression)
    ) {
      namespaces.set(node.name.text, {
        module: node.moduleReference.expression.text,
        symbol: symbolOf(node.name),
      });
    }
    return;
  }
  const exportModule = isExportDeclaration(node)
    ? node.moduleSpecifier
    : undefined;
  if (
    isExportDeclaration(node) &&
    exportModule !== undefined &&
    isStringLiteral(exportModule)
  ) {
    if (node.exportClause === undefined) {
      if (exportModule.text === "node:fs") {
        uses.add("mkdtemp");
        uses.add("mkdtempSync");
      } else if (exportModule.text === "node:fs/promises") {
        uses.add("mkdtemp");
      } else if (exportModule.text === NODE_OS_MODULE) {
        uses.add("tmpdir");
      }
    }
    if (node.exportClause !== undefined && isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        addForbiddenExport(
          exportModule.text,
          element.propertyName?.text ?? element.name.text,
          uses,
        );
      }
    }
    return;
  }
  if (!(isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier))) {
    return;
  }
  const { importClause } = node;
  if (importClause?.phaseModifier === SyntaxKind.TypeKeyword) {
    return;
  }
  const bindings = importClause?.namedBindings;
  const module = node.moduleSpecifier.text;
  if (importClause?.name !== undefined) {
    namespaces.set(importClause.name.text, {
      module,
      symbol: symbolOf(importClause.name),
    });
  }
  if (bindings !== undefined && isNamespaceImport(bindings)) {
    namespaces.set(bindings.name.text, {
      module,
      symbol: symbolOf(bindings.name),
    });
  } else if (bindings !== undefined && isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (
          NODE_FS_MODULES.has(module) &&
          (imported === "rm" || imported === "rmSync")
        ) {
          disposers.add(element.name.text);
        }
        addForbiddenExport(module, imported, uses);
      }
    }
  }
}

function scanNodes(
  sourceFile: SourceFile,
  namespaces: Map<string, NamespaceBinding>,
  disposers: ReadonlySet<string>,
  uses: Set<TemporaryOwnershipKind>,
): void {
  const disposableRoots = new Set<string>();
  const collectRoots = (node: Node): void => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer !== undefined &&
      disposableRootExpression(node.initializer)
    ) {
      disposableRoots.add(node.name.text);
    }
    node.forEachChild(collectRoots);
  };
  collectRoots(sourceFile);
  const visit = (node: Node, inheritedShadowing = new Set<string>()): void => {
    if (
      node.kind === SyntaxKind.TypeQuery ||
      node.kind === SyntaxKind.ImportType
    ) {
      return;
    }
    const shadowing = new Set(inheritedShadowing);
    const parameters = (
      node as Node & {
        parameters?: readonly { readonly name: Node }[];
      }
    ).parameters;
    for (const parameter of parameters ?? []) {
      if (isIdentifier(parameter.name)) {
        shadowing.add(parameter.name.text);
      }
    }
    if (
      isPropertyAccessExpression(node) &&
      isIdentifier(node.expression) &&
      isIdentifier(node.name) &&
      !shadowing.has(node.expression.text)
    ) {
      const binding = namespaces.get(node.expression.text);
      if (
        binding !== undefined &&
        sameSymbol(binding.symbol, symbolOf(node.expression)) &&
        runtimePosition(node)
      ) {
        addForbiddenExport(binding.module, node.name.text, uses);
      }
    }
    if (
      isPropertyAccessExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.name.text === "promises" &&
      !shadowing.has(node.expression.expression.text)
    ) {
      const binding = namespaces.get(node.expression.expression.text);
      if (
        binding?.module === "node:fs" &&
        sameSymbol(binding.symbol, symbolOf(node.expression.expression)) &&
        runtimePosition(node)
      ) {
        addForbiddenExport("node:fs/promises", node.name.text, uses);
      }
    }
    if (isPropertyAccessExpression(node)) {
      const module = loadedModule(node.expression);
      if (module !== undefined && runtimePosition(node)) {
        addForbiddenExport(module, node.name.text, uses);
      }
    }
    if (
      isElementAccessExpression(node) &&
      isIdentifier(node.expression) &&
      !shadowing.has(node.expression.text)
    ) {
      const binding = namespaces.get(node.expression.text);
      if (
        binding !== undefined &&
        sameSymbol(binding.symbol, symbolOf(node.expression)) &&
        node.argumentExpression !== undefined &&
        isStringLiteral(node.argumentExpression) &&
        runtimePosition(node)
      ) {
        addForbiddenExport(binding.module, node.argumentExpression.text, uses);
      }
    }
    if (isVariableDeclaration(node)) {
      if (isIdentifier(node.name) && node.initializer !== undefined) {
        const module = loadedModule(node.initializer);
        if (module !== undefined) {
          namespaces.set(node.name.text, {
            module,
            symbol: symbolOf(node.name),
          });
        }
      }
      scanNamespaceDestructuring(node, namespaces, uses);
    }
    if (
      ((isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) &&
        hardCodedHostTemp(node.text)) ||
      (isTemplateExpression(node) && hardCodedHostTemp(node.head.text))
    ) {
      uses.add("hard-coded-host-temp");
    }
    if (ambientTempAccess(node)) {
      uses.add("ambient-temp-env");
    }
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      disposers.has(node.expression.text) &&
      recursiveDisposal(node) &&
      (disposableRootExpression(node.arguments[0]) ||
        (node.arguments[0] !== undefined &&
          isIdentifier(node.arguments[0]) &&
          disposableRoots.has(node.arguments[0].text)))
    ) {
      uses.add("nested-recursive-disposal");
    }
    node.forEachChild((child) => visit(child, shadowing));
  };
  visit(sourceFile);
}

function disposableRootExpression(node: Node | undefined): boolean {
  if (node === undefined) return false;
  if (
    isCallExpression(node) &&
    isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "path"
  ) {
    return true;
  }
  return (
    (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) &&
    hardCodedHostTemp(node.text)
  );
}

function recursiveDisposal(call: Node): boolean {
  if (!isCallExpression(call)) return false;
  const options = call.arguments[1];
  if (options === undefined || !isObjectLiteralExpression(options))
    return false;
  return options.properties.some(
    (property) =>
      isPropertyAssignment(property) &&
      ((isIdentifier(property.name) && property.name.text === "recursive") ||
        (isStringLiteral(property.name) &&
          property.name.text === "recursive")) &&
      property.initializer.kind === SyntaxKind.TrueKeyword,
  );
}

function scanNamespaceDestructuring(
  node: Node,
  namespaces: ReadonlyMap<string, NamespaceBinding>,
  uses: Set<TemporaryOwnershipKind>,
): void {
  if (
    !(isVariableDeclaration(node) && isObjectBindingPattern(node.name)) ||
    node.initializer === undefined ||
    !isIdentifier(node.initializer)
  ) {
    return;
  }
  const binding = isIdentifier(node.initializer)
    ? namespaces.get(node.initializer.text)
    : undefined;
  const loaded = loadedModule(node.initializer);
  const module = binding?.module ?? loaded;
  if (
    module === undefined ||
    (binding !== undefined &&
      !sameSymbol(binding.symbol, symbolOf(node.initializer)))
  ) {
    return;
  }
  for (const element of node.name.elements) {
    const imported = bindingName(element.propertyName, element.name);
    if (imported !== undefined) {
      addForbiddenExport(module, imported, uses);
    }
  }
}

function bindingName(
  property: Node | undefined,
  local: Node | undefined,
): string | undefined {
  if (property !== undefined && isIdentifier(property)) {
    return property.text;
  }
  if (local !== undefined && isIdentifier(local)) {
    return local.text;
  }
  // biome-ignore lint/complexity/noUselessUndefined: TypeScript noImplicitReturns requires the explicit absent branch.
  return undefined;
}

function addForbiddenExport(
  module: string,
  name: string,
  uses: Set<TemporaryOwnershipKind>,
): void {
  const kind = forbiddenExport(module, name);
  if (kind !== undefined) {
    uses.add(kind);
  }
}

function forbiddenExport(
  module: string,
  name: string,
): TemporaryOwnershipKind | undefined {
  if (NODE_FS_MODULES.has(module) && FORBIDDEN_FS_EXPORTS.has(name)) {
    return name as "mkdtemp" | "mkdtempSync";
  }
  if (module === NODE_OS_MODULE && name === "tmpdir") {
    return "tmpdir";
  }
  // biome-ignore lint/complexity/noUselessUndefined: TypeScript noImplicitReturns requires the explicit absent branch.
  return undefined;
}

function hardCodedHostTemp(value: string): boolean {
  const normalized = value.replace(WINDOWS_SEPARATOR_PATTERN, "/");
  return (
    POSIX_TEMP_PATTERN.test(normalized) || WINDOWS_TEMP_PATTERN.test(normalized)
  );
}

function ambientTempAccess(node: Node): boolean {
  if (
    isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    isStringLiteral(node.argumentExpression) &&
    AMBIENT_TEMP_NAMES.has(node.argumentExpression.text) &&
    isPropertyAccessExpression(node.expression) &&
    isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    node.expression.name.text === "env"
  ) {
    return runtimePosition(node);
  }
  if (
    !(
      isPropertyAccessExpression(node) &&
      AMBIENT_TEMP_NAMES.has(node.name.text) &&
      isPropertyAccessExpression(node.expression)
    )
  ) {
    return false;
  }
  return (
    isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    node.expression.name.text === "env" &&
    runtimePosition(node)
  );
}

function loadedModule(node: Node): string | undefined {
  const call = isAwaitExpression(node) ? node.expression : node;
  if (!isCallExpression(call) || call.arguments.length !== 1) {
    return;
  }
  const argument = call.arguments[0];
  if (argument === undefined || !isStringLiteral(argument)) {
    return;
  }
  if (
    (isIdentifier(call.expression) && call.expression.text === "require") ||
    call.expression.kind === SyntaxKind.ImportKeyword
  ) {
    return argument.text;
  }
  // biome-ignore lint/complexity/noUselessUndefined: noImplicitReturns requires an explicit absent module.
  return undefined;
}

function symbolOf(node: Node): unknown {
  return (node as Node & { symbol?: unknown }).symbol;
}

function sameSymbol(expected: unknown, actual: unknown): boolean {
  return expected === undefined || actual === undefined || expected === actual;
}

function runtimePosition(node: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (
      current.kind === SyntaxKind.TypeQuery ||
      current.kind === SyntaxKind.ImportType
    ) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

function validateTemporaryOwnership(
  item: WorkspacePackage,
  relativePath: string,
  uses: readonly TemporaryOwnershipUse[],
  findings: WorkspaceFinding[],
): void {
  const path = `${item.relativeRoot}/${relativePath}`;
  const exactDisposition = TEMPORARY_OWNERSHIP_DISPOSITIONS.find(
    (candidate) => candidate.path === path,
  );
  for (const { kind } of uses) {
    if (!exactDisposition?.allowedUses.includes(kind)) {
      addFinding(
        findings,
        "disposable-temp-ownership",
        path,
        `${kind} is disposable temporary-root authority owned by @skizzles/run-workspace`,
      );
    }
  }
}

function disposition(
  path: string,
  allowedUses: readonly TemporaryOwnershipKind[],
  reason: string,
): TemporaryOwnershipDisposition {
  return { path, allowedUses, reason };
}

function packagePath(packageName: string, relativePath: string): string {
  return ["packages", packageName, relativePath].join("/");
}

export {
  scanTemporaryOwnership,
  TEMPORARY_OWNERSHIP_DISPOSITIONS,
  type TemporaryOwnershipDisposition,
  type TemporaryOwnershipKind,
  type TemporaryOwnershipUse,
  validateTemporaryOwnership,
};
