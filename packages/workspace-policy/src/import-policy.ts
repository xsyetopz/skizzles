import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  addFinding,
  type WorkspaceFinding,
  type WorkspacePackage,
} from "./workspace-contract.ts";
import { listFiles } from "./workspace-files.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IMPORT_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ".json"]);
const GENERATED_DIRECTORIES = new Set([
  "dist",
  "generated",
  "node_modules",
  "vendor",
]);
const GENERATED_FILE_PATTERN = /(?:\.d|\.gen|\.generated)\.ts$/u;

export async function validateWorkspaceImports(
  packages: readonly WorkspacePackage[],
  findings: WorkspaceFinding[],
): Promise<void> {
  const packagesByName = new Map(
    packages.map((item) => [item.manifest.name, item]),
  );
  for (const item of packages) {
    const files = (await listFiles(item.root, GENERATED_DIRECTORIES)).filter(
      (path) =>
        SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) &&
        !GENERATED_FILE_PATTERN.test(path),
    );
    for (const sourcePath of files) {
      const relativePath = toPortablePath(relative(item.root, sourcePath));
      validateImports(
        item,
        sourcePath,
        relativePath,
        await readFile(sourcePath, "utf8"),
        packagesByName,
        findings,
      );
    }
  }
}

function validateImports(
  item: WorkspacePackage,
  sourcePath: string,
  relativePath: string,
  sourceWithShebang: string,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  findings: WorkspaceFinding[],
): void {
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
  for (const { path: specifier } of imports) {
    validateImport(
      item,
      sourcePath,
      relativePath,
      specifier,
      packagesByName,
      findings,
    );
  }
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
      } else if (
        targetOwnership.startsWith("generated/") ||
        GENERATED_FILE_PATTERN.test(targetOwnership)
      ) {
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
  if (
    !(
      dependency in item.manifest.dependencies ||
      (inTest && dependency in item.manifest.devDependencies)
    )
  ) {
    addFinding(
      findings,
      "undeclared-dependency",
      findingPath,
      `${dependency} is not a direct ${inTest ? "dependency or devDependency" : "runtime dependency"}`,
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
