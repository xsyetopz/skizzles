import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateExportImports } from "./export-import-policy.ts";
import {
  addFinding,
  type PackageManifest,
  type WorkspaceFinding,
  type WorkspaceManifest,
} from "./workspace-contract.ts";

const TOOL_DEPENDENCIES = ["@types/bun", "@types/node", "typescript"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const PORTABLE_FASTMCP_ROOT =
  "skills/codex-project-tooling/assets/fastmcp-bun-template";
const PORTABLE_FASTMCP_CHECK =
  "bunx @biomejs/biome@2.5.4 check --config-path ./biome.jsonc ./biome.jsonc ./package.json ./tsconfig.json ./src ./test";

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
      "manifest must declare name, version, private ESM status, scripts, dependencies, exports, and bin",
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
  const exports = entrypointRecord(value["exports"]);
  const bin = entrypointRecord(value["bin"]);
  if (
    scripts === undefined ||
    dependencies === undefined ||
    devDependencies === undefined ||
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
    exports,
    bin,
  };
}

export function validateRootManifest(
  manifest: WorkspaceManifest,
  findings: WorkspaceFinding[],
): void {
  if (Object.keys(manifest.dependencies).length > 0) {
    findings.push({
      code: "root-runtime-dependency",
      path: "package.json",
      message: "the orchestration root must not own runtime dependencies",
    });
  }
  for (const dependency of ["fastmcp", "zod"]) {
    if (dependency in manifest.devDependencies) {
      findings.push({
        code: "ambient-template-dependency",
        path: "package.json",
        message: `${dependency} must be owned by the template workspace package`,
      });
    }
  }
  if (!manifest.workspaces.includes("packages/*")) {
    findings.push({
      code: "workspace-discovery",
      path: "package.json",
      message: "root workspaces must discover packages/*",
    });
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
  const check = manifest.scripts["check"];
  if (check !== undefined) {
    const workspacePath = toPortablePath(relative(relativeRoot, "."));
    const configPath = `${workspacePath}/biome.jsonc`;
    const requiredPrefix = `bunx @biomejs/biome@2.5.4 check --config-path ${configPath} --vcs-root ${workspacePath}`;
    const usesPortableFastMcpCheck =
      relativeRoot === PORTABLE_FASTMCP_ROOT &&
      check === PORTABLE_FASTMCP_CHECK;
    if (
      !(
        usesPortableFastMcpCheck ||
        check === requiredPrefix ||
        check.startsWith(`${requiredPrefix} `)
      )
    ) {
      addFinding(
        findings,
        "invalid-biome-command",
        relativeRoot,
        `package check must start with ${requiredPrefix}`,
      );
    }
  }
}

function validatePackageDependencies(
  relativeRoot: string,
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): void {
  if (
    "@biomejs/biome" in manifest.dependencies ||
    "@biomejs/biome" in manifest.devDependencies
  ) {
    addFinding(
      findings,
      "local-biome-dependency",
      relativeRoot,
      "Biome must not be installed as a workspace dependency",
    );
  }
  for (const dependency of TOOL_DEPENDENCIES) {
    if (
      !(
        dependency in manifest.dependencies ||
        dependency in manifest.devDependencies
      )
    ) {
      addFinding(
        findings,
        "missing-tool-dependency",
        relativeRoot,
        `missing direct ${dependency} dependency`,
      );
    }
  }
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    if (name.startsWith("@skizzles/") && range !== "workspace:*") {
      addFinding(
        findings,
        "workspace-range",
        relativeRoot,
        `${name} must use workspace:*`,
      );
    }
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
}

function validateEntrypoints(
  relativeRoot: string,
  packageRoot: string,
  kind: "exports" | "bin",
  entrypoints: Record<string, string>,
  findings: WorkspaceFinding[],
): void {
  if (Object.keys(entrypoints).length === 0) {
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
