import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  addFinding,
  type PackageManifest,
  type WorkspaceFinding,
  type WorkspaceManifest,
} from "./contract.ts";
import {
  validatePackageDependencies,
  validateRootDependencyPolicy,
} from "./dependencies.ts";
import { validateExportImports } from "./export-imports.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const REQUIRED_PACKAGE_SCRIPTS = {
  check:
    "bunx @biomejs/biome@2.5.4 check --config-path ../../biome.jsonc --vcs-root ../.. ./src ./test ./package.json ./tsconfig.json",
  test: "bun test",
  typecheck: "tsc -p tsconfig.json --noEmit",
} as const;

export async function readWorkspaceManifest(
  root: string,
  findings: WorkspaceFinding[],
): Promise<WorkspaceManifest | undefined> {
  const value = await readJson(join(root, "package.json"), findings);
  const manifest = packageManifest(value);
  if (
    manifest === undefined ||
    !isRecord(value) ||
    !stringArray(value["workspaces"])
  ) {
    findings.push({
      code: "invalid-root-manifest",
      path: "package.json",
      message:
        "root manifest must define a valid package contract and workspaces",
    });
    return;
  }
  return { ...manifest, workspaces: value["workspaces"] };
}

export async function readPackageManifest(
  packageRoot: string,
  findings: WorkspaceFinding[],
): Promise<PackageManifest | undefined> {
  const manifestPath = join(packageRoot, "package.json");
  const value = await readJson(manifestPath, findings);
  const manifest = packageManifest(value);
  if (manifest !== undefined) {
    return manifest;
  }
  findings.push({
    code: "invalid-package-manifest",
    path: toPortablePath(packageRoot),
    message:
      "manifest must declare name, version, private ESM status, scripts, string-valued dependency maps, and exports; bin is optional",
  });
  return undefined;
}

function packageManifest(value: unknown): PackageManifest | undefined {
  if (
    !isRecord(value) ||
    typeof value["name"] !== "string" ||
    typeof value["version"] !== "string" ||
    value["private"] !== true ||
    value["type"] !== "module"
  ) {
    return;
  }
  const scripts = stringRecord(value["scripts"]);
  const dependencies = optionalStringRecord(value["dependencies"]);
  const devDependencies = optionalStringRecord(value["devDependencies"]);
  const optionalDependencies = optionalStringRecord(
    value["optionalDependencies"],
  );
  const peerDependencies = optionalStringRecord(value["peerDependencies"]);
  const exports = entrypointRecord(value["exports"]);
  const bin = entrypointRecord(value["bin"]);
  if (
    scripts === undefined ||
    dependencies === undefined ||
    devDependencies === undefined ||
    optionalDependencies === undefined ||
    peerDependencies === undefined ||
    exports === undefined ||
    bin === undefined
  ) {
    return;
  }
  return {
    name: value["name"],
    version: value["version"],
    private: true,
    type: "module",
    scripts,
    dependencies,
    devDependencies,
    optionalDependencies,
    peerDependencies,
    exports,
    bin,
  };
}

export function validateRootManifest(
  manifest: WorkspaceManifest,
  findings: WorkspaceFinding[],
): void {
  validateRootDependencyPolicy(manifest, findings);
  for (const dependency of ["fastmcp", "zod"]) {
    if (dependency in manifest.devDependencies) {
      findings.push({
        code: "ambient-template-dependency",
        path: "package.json",
        message: `${dependency} must be owned by the template workspace package`,
      });
    }
  }
  if (
    manifest.workspaces.length !== 1 ||
    manifest.workspaces[0] !== "packages/*"
  ) {
    findings.push({
      code: "workspace-discovery",
      path: "package.json",
      message: 'root workspaces must be exactly ["packages/*"]',
    });
  }
  const aggregateScripts = {
    "packages:build": "bun run --workspaces --sequential build",
    "packages:check": "bun run --workspaces --sequential check",
    typecheck: "bun run --workspaces --sequential typecheck",
    test: "bun run --workspaces --sequential test",
  } as const;
  for (const [name, command] of Object.entries(aggregateScripts)) {
    if (manifest.scripts[name] !== command) {
      addFinding(
        findings,
        "invalid-aggregate-script",
        "package.json",
        `${name} must be ${command}`,
      );
    }
  }
}

export async function validatePackage(
  rootManifest: WorkspaceManifest,
  relativeRoot: string,
  packageRoot: string,
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): Promise<void> {
  validatePackageMetadata(rootManifest, relativeRoot, manifest, findings);
  validatePackageDependencies(relativeRoot, manifest, findings);
  await validateRequiredPackageFiles(relativeRoot, packageRoot, findings);
  validateEntrypoints(
    relativeRoot,
    packageRoot,
    "exports",
    manifest.exports,
    findings,
  );
  validateEntrypoints(relativeRoot, packageRoot, "bin", manifest.bin, findings);
  await validateEntrypointBuilds(relativeRoot, packageRoot, manifest, findings);
  await validateExportImports(relativeRoot, packageRoot, manifest, findings);
}

function validatePackageMetadata(
  rootManifest: WorkspaceManifest,
  relativeRoot: string,
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): void {
  if (
    !(
      manifest.name.startsWith("@skizzles/") ||
      relativeRoot.startsWith("skills/")
    )
  ) {
    addFinding(
      findings,
      "unscoped-package",
      relativeRoot,
      "package name must use the @skizzles scope",
    );
  }
  if (manifest.version !== rootManifest.version) {
    addFinding(
      findings,
      "version-drift",
      relativeRoot,
      "package version must equal the root version",
    );
  }
  for (const script of ["build", "typecheck", "test", "check"]) {
    if (!(script in manifest.scripts)) {
      addFinding(
        findings,
        "missing-package-script",
        relativeRoot,
        `missing ${script} script`,
      );
    }
  }
  if (manifest.scripts["check"] !== REQUIRED_PACKAGE_SCRIPTS.check) {
    addFinding(
      findings,
      "invalid-biome-command",
      relativeRoot,
      `package check must be ${REQUIRED_PACKAGE_SCRIPTS.check}`,
    );
  }
  if (manifest.scripts["typecheck"] !== REQUIRED_PACKAGE_SCRIPTS.typecheck) {
    addFinding(
      findings,
      "invalid-typecheck-command",
      relativeRoot,
      `package typecheck must be ${REQUIRED_PACKAGE_SCRIPTS.typecheck}`,
    );
  }
  const test = manifest.scripts["test"];
  if (
    test !== undefined &&
    (!(test === "bun test test" || test.startsWith("bun test ")) ||
      !/(?:^|\s)(?:\.\/)?test(?:\s|$)/u.test(test) ||
      test.includes("--watch"))
  ) {
    addFinding(
      findings,
      "invalid-test-command",
      relativeRoot,
      "package test must run the owned test directory once with bun test",
    );
  }
  const build = manifest.scripts["build"];
  if (
    build !== undefined &&
    !(
      build.startsWith("bun build ") &&
      build.includes("--target=bun") &&
      /(?:--outdir=\.?\/?dist|--outfile=\.?\/?dist\/)/u.test(build)
    )
  ) {
    addFinding(
      findings,
      "invalid-build-command",
      relativeRoot,
      "package build must explicitly build Bun entrypoints into dist",
    );
  }
}

async function validateRequiredPackageFiles(
  relativeRoot: string,
  packageRoot: string,
  findings: WorkspaceFinding[],
): Promise<void> {
  for (const required of ["README.md", "tsconfig.json", "src", "test"]) {
    if (!(await exists(join(packageRoot, required)))) {
      addFinding(
        findings,
        "missing-package-file",
        relativeRoot,
        `missing ${required}`,
      );
    }
  }
  await validatePackageTsconfig(relativeRoot, packageRoot, findings);
}

async function validatePackageTsconfig(
  relativeRoot: string,
  packageRoot: string,
  findings: WorkspaceFinding[],
): Promise<void> {
  const path = join(packageRoot, "tsconfig.json");
  const value = await readJson(path, findings);
  if (
    !isRecord(value) ||
    value["extends"] !== "../../tsconfig.base.json" ||
    !Array.isArray(value["include"]) ||
    value["include"].length !== 2 ||
    value["include"][0] !== "src/**/*.ts" ||
    value["include"][1] !== "test/**/*.ts"
  ) {
    addFinding(
      findings,
      "invalid-package-tsconfig",
      relativeRoot,
      "tsconfig must extend ../../tsconfig.base.json and include only owned src/test TypeScript",
    );
  }
}

function validateEntrypoints(
  relativeRoot: string,
  packageRoot: string,
  kind: "exports" | "bin",
  entrypoints: Record<string, string>,
  findings: WorkspaceFinding[],
): void {
  if (kind === "exports" && Object.keys(entrypoints).length === 0) {
    addFinding(
      findings,
      `missing-${kind}`,
      relativeRoot,
      `${kind} must declare an intentional supported surface`,
    );
  }
  for (const [name, target] of Object.entries(entrypoints)) {
    const absoluteTarget = resolve(packageRoot, target);
    const supportedRoot =
      target.startsWith("./src/") ||
      (kind === "exports" &&
        (target.startsWith("./assets/") || target === "./package.json"));
    if (!(inside(packageRoot, absoluteTarget) && supportedRoot)) {
      addFinding(
        findings,
        `invalid-${kind}-target`,
        relativeRoot,
        `${name} must target package src`,
      );
    } else if (Bun.file(absoluteTarget).size === 0) {
      addFinding(
        findings,
        `missing-${kind}-target`,
        relativeRoot,
        `${name} targets missing ${target}`,
      );
    }
  }
}

async function validateEntrypointBuilds(
  relativeRoot: string,
  packageRoot: string,
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): Promise<void> {
  const targets = new Set([
    ...Object.values(manifest.exports),
    ...Object.values(manifest.bin),
  ]);
  const entrypoints = [...targets]
    .filter((target) =>
      SOURCE_EXTENSIONS.has(target.slice(target.lastIndexOf("."))),
    )
    .map((target) => resolve(packageRoot, target));
  if (entrypoints.length === 0) {
    return;
  }
  const config: Bun.BuildConfig & { write: false } = {
    entrypoints,
    format: "esm",
    packages: "external",
    target: "bun",
    write: false,
  };
  let diagnostic = "";
  try {
    const result = await Bun.build(config);
    if (result.success) {
      return;
    }
    diagnostic = result.logs.map((log) => log.message).join("; ");
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : String(error);
  }
  addFinding(
    findings,
    "entrypoint-build-failed",
    relativeRoot,
    diagnostic || "Bun could not build the declared entrypoints",
  );
}

async function readJson(
  path: string,
  findings: WorkspaceFinding[],
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    addFinding(
      findings,
      "invalid-json",
      toPortablePath(path),
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

function entrypointRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value === "string") {
    return { ".": value };
  }
  return optionalStringRecord(value);
}

function optionalStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) {
    return {};
  }
  return stringRecord(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      return;
    }
    result[key] = item;
  }
  return result;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return (
    offset === "" || !(offset.startsWith(`..${sep}`) || isAbsolute(offset))
  );
}

function toPortablePath(path: string): string {
  return path.split(/[\\\\/]/u).join("/");
}
