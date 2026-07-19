import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  addFinding,
  type WorkspaceFinding,
  type WorkspacePackage,
} from "./contract.ts";
import { hasRuntimeDependency } from "./dependencies.ts";
import { listFiles } from "./filesystem.ts";
import { scanStaticModuleSpecifiers } from "./source/declarations.ts";
import {
  type SourceModule,
  validateSourceModuleCycles,
} from "./source/graph.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IMPORT_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ".json"]);
const IMPORT_DISCOVERY_EXCLUSIONS = new Set(["dist", "node_modules", "vendor"]);
const GENERATED_FILE_PATTERN = /(?:\.d|\.gen|\.generated)\.ts$/u;

export async function validateWorkspaceImports(
  packages: readonly WorkspacePackage[],
  findings: WorkspaceFinding[],
): Promise<void> {
  const packagesByName = new Map(
    packages.map((item) => [item.manifest.name, item]),
  );
  for (const item of packages) {
    const files = (
      await listFiles(item.root, IMPORT_DISCOVERY_EXCLUSIONS)
    ).filter((path) =>
      SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))),
    );
    const sourceModules: SourceModule[] = [];
    for (const sourcePath of files) {
      const relativePath = toPortablePath(relative(item.root, sourcePath));
      if (isGeneratedOwnership(relativePath)) {
        continue;
      }
      const specifiers = validateImports(
        item,
        sourcePath,
        relativePath,
        await readFile(sourcePath, "utf8"),
        packagesByName,
        findings,
      );
      if (relativePath.startsWith("src/") && specifiers !== undefined) {
        sourceModules.push({
          path: sourcePath,
          relativePath,
          specifiers,
        });
      }
    }
    validateSourceModuleCycles(item, sourceModules, findings);
  }
}

function validateImports(
  item: WorkspacePackage,
  sourcePath: string,
  relativePath: string,
  sourceWithShebang: string,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  findings: WorkspaceFinding[],
): readonly string[] | undefined {
  const source = stripShebang(sourceWithShebang);
  const loader = sourcePath.endsWith("x") ? "tsx" : "ts";
  let imports: Bun.Import[];
  try {
    imports = new Bun.Transpiler({ loader }).scanImports(source);
  } catch (error) {
    addFinding(
      findings,
      "source-parse-error",
      `${item.relativeRoot}/${relativePath}`,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  const specifiers = new Set([
    ...imports.map(({ path }) => path),
    ...scanStaticModuleSpecifiers(source),
  ]);
  for (const specifier of specifiers) {
    validateImport(
      item,
      sourcePath,
      relativePath,
      specifier,
      packagesByName,
      findings,
    );
  }
  return [...specifiers];
}

function validateImport(
  item: WorkspacePackage,
  sourcePath: string,
  relativePath: string,
  specifier: string,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  findings: WorkspaceFinding[],
): void {
  const findingPath = `${item.relativeRoot}/${relativePath}`;
  if (specifier.startsWith(".")) {
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
    } else if (relativePath.startsWith("src/")) {
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
    return;
  }
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
      `${dependency} is not a direct ${inTest ? "runtime, optional, peer, or development dependency" : "runtime, optional, or peer dependency"}`,
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

function packageSubpath(specifier: string, dependency: string): string {
  const suffix = specifier.slice(dependency.length);
  return suffix === "" ? "." : `.${suffix}`;
}

function isGeneratedOwnership(path: string): boolean {
  return (
    path.split("/").includes("generated") || GENERATED_FILE_PATTERN.test(path)
  );
}

function stripShebang(source: string): string {
  if (!source.startsWith("#!")) {
    return source;
  }
  const newline = source.indexOf("\n");
  return newline === -1 ? "" : source.slice(newline + 1);
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
