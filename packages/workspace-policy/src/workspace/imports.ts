import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  addFinding,
  type WorkspaceFinding,
  type WorkspacePackage,
} from "./contract.ts";
import { hasRuntimeDependency } from "./dependencies.ts";
import {
  discoverOwnedSources,
  isGeneratedOwnership,
} from "./source/documents.ts";
import {
  type SourceModule,
  validateSourceModuleCycles,
} from "./source/graph.ts";
import { parseSourceDependencies } from "./source/parser.ts";

const IMPORT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".json"]);

interface ImportValidationContext {
  item: WorkspacePackage;
  sourcePath: string;
  relativePath: string;
  packagesByName: ReadonlyMap<string, WorkspacePackage>;
  findings: WorkspaceFinding[];
}

async function validateWorkspaceImports(
  packages: readonly WorkspacePackage[],
  findings: WorkspaceFinding[],
): Promise<void> {
  const packagesByName = new Map(
    packages.map((item) => [item.manifest.name, item]),
  );
  const sources = await discoverOwnedSources(packages);
  const ownersByPath = new Map(
    sources.map(({ document, item, relativePath }) => [
      document.path,
      { item, relativePath },
    ]),
  );
  const modulesByPackage = new Map<WorkspacePackage, SourceModule[]>();
  const parsedSources = await parseSourceDependencies(
    sources.map(({ document }) => document),
  );
  for (const parsed of parsedSources) {
    consumeParsedSource(
      parsed,
      ownersByPath,
      packagesByName,
      modulesByPackage,
      findings,
    );
  }
  for (const item of packages) {
    validateSourceModuleCycles(
      item,
      modulesByPackage.get(item) ?? [],
      findings,
    );
  }
}

function consumeParsedSource(
  parsed: Awaited<ReturnType<typeof parseSourceDependencies>>[number],
  ownersByPath: ReadonlyMap<
    string,
    { item: WorkspacePackage; relativePath: string }
  >,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  modulesByPackage: Map<WorkspacePackage, SourceModule[]>,
  findings: WorkspaceFinding[],
): void {
  const owner = ownersByPath.get(parsed.path);
  if (owner === undefined) {
    return;
  }
  const { item, relativePath } = owner;
  if (parsed.error !== undefined) {
    addFinding(
      findings,
      "source-parse-error",
      `${item.relativeRoot}/${relativePath}`,
      parsed.error,
    );
    return;
  }
  const specifiers = parsed.specifiers ?? [];
  const context = {
    item,
    sourcePath: parsed.path,
    relativePath,
    packagesByName,
    findings,
  };
  for (const specifier of specifiers) {
    validateImport(specifier, context);
  }
  if (relativePath.startsWith("src/")) {
    const modules = modulesByPackage.get(item) ?? [];
    modules.push({ path: parsed.path, relativePath, specifiers });
    modulesByPackage.set(item, modules);
  }
}

function validateImport(
  specifier: string,
  context: ImportValidationContext,
): void {
  if (specifier.startsWith(".")) {
    validateRelativeImport(specifier, context);
    return;
  }
  validatePackageImport(specifier, context);
}

function validateRelativeImport(
  specifier: string,
  context: ImportValidationContext,
): void {
  const { item, sourcePath, relativePath, findings } = context;
  const findingPath = `${item.relativeRoot}/${relativePath}`;
  const extension = specifier.slice(specifier.lastIndexOf("."));
  if (!IMPORT_EXTENSIONS.has(extension)) {
    addFinding(
      findings,
      "missing-import-extension",
      findingPath,
      `${specifier} must use a TypeScript extension`,
    );
  }
  const target = resolve(dirname(sourcePath), specifier);
  if (!inside(item.root, target)) {
    addFinding(
      findings,
      "cross-package-relative-import",
      findingPath,
      `${specifier} escapes its package`,
    );
    return;
  }
  if (relativePath.startsWith("src/")) {
    validateProductionTarget(item, target, findingPath, specifier, findings);
  }
}

function validateProductionTarget(
  item: WorkspacePackage,
  target: string,
  findingPath: string,
  specifier: string,
  findings: WorkspaceFinding[],
): void {
  const targetOwnership = toPortablePath(relative(item.root, target));
  if (targetOwnership.startsWith("test/")) {
    addFinding(
      findings,
      "production-to-test-import",
      findingPath,
      `${specifier} points production code at test ownership`,
    );
  } else if (isGeneratedOwnership(targetOwnership)) {
    addFinding(
      findings,
      "production-to-generated-import",
      findingPath,
      `${specifier} points production code at generated ownership`,
    );
  }
}

function validatePackageImport(
  specifier: string,
  context: ImportValidationContext,
): void {
  const { item, relativePath, packagesByName, findings } = context;
  const findingPath = `${item.relativeRoot}/${relativePath}`;
  const dependency = dependencyName(specifier);
  if (dependency === undefined) {
    return;
  }
  const inTest = relativePath.startsWith("test/");
  const runtimeDependency =
    dependency === item.manifest.name ||
    hasRuntimeDependency(item.manifest, dependency);
  if (
    !(
      runtimeDependency ||
      (inTest && dependency in item.manifest.devDependencies)
    )
  ) {
    addFinding(
      findings,
      "undeclared-dependency",
      findingPath,
      `${dependency} is not a direct ${allowedDependencyKinds(inTest)}`,
    );
    return;
  }
  const targetPackage = packagesByName.get(dependency);
  if (targetPackage === undefined) {
    return;
  }
  const subpath = packageSubpath(specifier, dependency);
  if (!(subpath in targetPackage.manifest.exports)) {
    addFinding(
      findings,
      "private-package-import",
      findingPath,
      `${specifier} is not an exported surface of ${dependency}`,
    );
  }
}

function allowedDependencyKinds(
  inTest: boolean,
):
  | "runtime, optional, peer, or development dependency"
  | "runtime, optional, or peer dependency" {
  if (inTest) {
    return "runtime, optional, peer, or development dependency";
  }
  return "runtime, optional, or peer dependency";
}

function packageSubpath(specifier: string, dependency: string): string {
  const suffix = specifier.slice(dependency.length);
  return suffix === "" ? "." : `.${suffix}`;
}

function dependencyName(specifier: string): string | undefined {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    return;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return (
    offset === "" || !(offset.startsWith(`..${sep}`) || isAbsolute(offset))
  );
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

export { validateWorkspaceImports };
