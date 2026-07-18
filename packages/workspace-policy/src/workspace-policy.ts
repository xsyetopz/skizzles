import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const TOOL_DEPENDENCIES = ["@types/bun", "@types/node", "typescript"] as const;
export const SKIZZLES_PACKAGE_NAMES = [
  "@skizzles/command-hook",
  "@skizzles/command-supervisor",
  "@skizzles/container-lab",
  "@skizzles/installer",
  "@skizzles/model-catalog",
  "@skizzles/plugin-builder",
  "@skizzles/prompt-layer",
  "@skizzles/usage-analyzer",
  "@skizzles/workspace-policy",
  "codex-fastmcp-template",
] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IMPORT_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ".json"]);
const EXPORT_IMPORT_TIMEOUT_MS = 1_000;
const PORTABLE_FASTMCP_ROOT =
  "skills/codex-project-tooling/assets/fastmcp-bun-template";
const PORTABLE_FASTMCP_CHECK =
  "bunx @biomejs/biome@2.5.4 check --config-path ./biome.jsonc ./biome.jsonc ./package.json ./tsconfig.json ./src ./test";

export interface WorkspaceFinding {
  code: string;
  path: string;
  message: string;
}

export interface WorkspacePolicyOptions {
  expectedPackageNames?: readonly string[];
}

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  type: "module";
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  exports: Record<string, string>;
  bin: Record<string, string>;
}

interface WorkspaceManifest extends PackageManifest {
  workspaces: string[];
}

export async function validateWorkspace(
  workspaceRoot: string,
  options: WorkspacePolicyOptions = {},
): Promise<WorkspaceFinding[]> {
  const root = resolve(workspaceRoot);
  const findings: WorkspaceFinding[] = [];
  const rootManifest = await readWorkspaceManifest(root, findings);
  if (rootManifest === undefined) {
    return findings;
  }

  validateRootManifest(rootManifest, findings);
  const packageRoots = await discoverPackageRoots(
    root,
    rootManifest.workspaces,
  );
  const names = new Map<string, string>();
  for (const packageRoot of packageRoots) {
    const relativeRoot = portable(relative(root, packageRoot));
    const manifest = await readPackageManifest(packageRoot, findings);
    if (manifest === undefined) {
      continue;
    }
    await validatePackage(
      rootManifest,
      relativeRoot,
      packageRoot,
      manifest,
      findings,
    );
    const previous = names.get(manifest.name);
    if (previous === undefined) {
      names.set(manifest.name, relativeRoot);
    } else {
      findings.push({
        code: "duplicate-package-name",
        path: relativeRoot,
        message: `${manifest.name} is already owned by ${previous}`,
      });
    }
    await validateImports(packageRoot, manifest, findings);
  }

  validateExpectedPackageNames(names, options.expectedPackageNames, findings);
  await validateLockfiles(root, findings);
  await validateRootSourceIsolation(root, packageRoots, findings);
  return findings.sort(compareFindings);
}

async function readWorkspaceManifest(
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
    return undefined;
  }
  return { ...manifest, workspaces: value["workspaces"] };
}

async function readPackageManifest(
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
    path: portable(packageRoot),
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
    return undefined;
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
    return undefined;
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

function validateRootManifest(
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

async function validatePackage(
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
    add(
      findings,
      "unscoped-package",
      relativeRoot,
      "package name must use the @skizzles scope",
    );
  }
  if (manifest.version !== rootManifest.version) {
    add(
      findings,
      "version-drift",
      relativeRoot,
      "package version must equal the root version",
    );
  }
  for (const script of ["build", "typecheck", "test", "check"]) {
    if (!(script in manifest.scripts)) {
      add(
        findings,
        "missing-package-script",
        relativeRoot,
        `missing ${script} script`,
      );
    }
  }
  const check = manifest.scripts["check"];
  if (check !== undefined) {
    const workspacePath = portable(relative(relativeRoot, "."));
    const configPath = `${workspacePath}/biome.jsonc`;
    const requiredPrefix = `bunx @biomejs/biome@2.5.4 check --config-path ${configPath} --vcs-root ${workspacePath}`;
    const usesPortableFastMcpCheck =
      relativeRoot === PORTABLE_FASTMCP_ROOT &&
      check === PORTABLE_FASTMCP_CHECK;
    if (
      !usesPortableFastMcpCheck &&
      !(check === requiredPrefix || check.startsWith(`${requiredPrefix} `))
    ) {
      add(
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
    add(
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
      add(
        findings,
        "missing-tool-dependency",
        relativeRoot,
        `missing direct ${dependency} dependency`,
      );
    }
  }
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    if (name.startsWith("@skizzles/") && range !== "workspace:*") {
      add(
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
      add(
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
    add(
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
      add(
        findings,
        `invalid-${kind}-target`,
        relativeRoot,
        `${name} must target package src`,
      );
    } else if (Bun.file(absoluteTarget).size === 0) {
      add(
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
  add(
    findings,
    "entrypoint-build-failed",
    relativeRoot,
    diagnostic || "Bun could not build the declared entrypoints",
  );
}

async function validateExportImports(
  relativeRoot: string,
  packageRoot: string,
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): Promise<void> {
  for (const [name, target] of Object.entries(manifest.exports)) {
    if (!SOURCE_EXTENSIONS.has(target.slice(target.lastIndexOf(".")))) {
      continue;
    }
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        'const specifier = process.env.SKIZZLES_EXPORT_SPECIFIER; if (!specifier) throw new Error("missing export specifier"); await import(specifier);',
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          SKIZZLES_EXPORT_SPECIFIER:
            name === "." ? manifest.name : `${manifest.name}${name.slice(1)}`,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = Promise.withResolvers<"deadline">();
    const timeout = setTimeout(
      () => deadline.resolve("deadline"),
      EXPORT_IMPORT_TIMEOUT_MS,
    );
    const outcome = await Promise.race([child.exited, deadline.promise]);
    clearTimeout(timeout);
    if (outcome === "deadline") {
      child.kill("SIGKILL");
    }
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (
      outcome === "deadline" ||
      exitCode !== 0 ||
      stdout.length > 0 ||
      stderr.length > 0
    ) {
      const reason =
        outcome === "deadline"
          ? "did not settle while stdin remained open"
          : exitCode !== 0
            ? `exited with status ${exitCode}`
            : "wrote to stdout or stderr";
      add(
        findings,
        "unsafe-export-import",
        relativeRoot,
        `${name} (${target}) ${reason} during import`,
      );
    }
  }
}

async function validateImports(
  packageRoot: string,
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): Promise<void> {
  const sourceFiles = await listTypeScriptFiles(packageRoot);
  for (const sourcePath of sourceFiles) {
    const source = stripShebang(await readFile(sourcePath, "utf8"));
    const loader = sourcePath.endsWith("x") ? "tsx" : "ts";
    const transpiler = new Bun.Transpiler({ loader });
    let imports: Bun.Import[];
    try {
      imports = transpiler.scanImports(source);
    } catch (error) {
      add(
        findings,
        "source-parse-error",
        portable(sourcePath),
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    for (const { path: specifier } of imports) {
      validateImport(packageRoot, sourcePath, specifier, manifest, findings);
    }
  }
}

function stripShebang(source: string): string {
  if (!source.startsWith("#!")) {
    return source;
  }
  const newline = source.indexOf("\n");
  return newline === -1 ? "" : source.slice(newline + 1);
}

function validateImport(
  packageRoot: string,
  sourcePath: string,
  specifier: string,
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): void {
  if (specifier.startsWith(".")) {
    validateRelativeImport(packageRoot, sourcePath, specifier, findings);
    return;
  }
  const dependency = dependencyName(specifier);
  if (dependency === undefined || dependency in manifest.dependencies) {
    return;
  }
  const inTest = portable(relative(packageRoot, sourcePath)).startsWith(
    "test/",
  );
  if (inTest && dependency in manifest.devDependencies) {
    return;
  }
  add(
    findings,
    "undeclared-dependency",
    portable(sourcePath),
    `${dependency} is not a direct ${inTest ? "dependency or devDependency" : "runtime dependency"}`,
  );
}

function validateRelativeImport(
  packageRoot: string,
  sourcePath: string,
  specifier: string,
  findings: WorkspaceFinding[],
): void {
  const extension = specifier.slice(specifier.lastIndexOf("."));
  if (!IMPORT_EXTENSIONS.has(extension)) {
    add(
      findings,
      "missing-import-extension",
      portable(sourcePath),
      `${specifier} must use a TypeScript extension`,
    );
  }
  const target = resolve(dirname(sourcePath), specifier);
  if (!inside(packageRoot, target)) {
    add(
      findings,
      "cross-package-relative-import",
      portable(sourcePath),
      `${specifier} escapes its package`,
    );
  }
}

async function discoverPackageRoots(
  root: string,
  patterns: readonly string[],
): Promise<string[]> {
  const roots = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      roots.add(resolve(root, pattern));
      continue;
    }
    const parent = resolve(root, pattern.slice(0, -2));
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (await exists(join(parent, entry.name, "package.json")))
      ) {
        roots.add(join(parent, entry.name));
      }
    }
  }
  return [...roots].sort();
}

async function validateLockfiles(
  root: string,
  findings: WorkspaceFinding[],
): Promise<void> {
  for (const path of await listFiles(root, new Set([".git", "node_modules"]))) {
    if (path.endsWith(`${sep}bun.lock`) && path !== join(root, "bun.lock")) {
      add(
        findings,
        "nested-lockfile",
        portable(relative(root, path)),
        "only the root bun.lock is allowed",
      );
    }
    if (path.endsWith(".tsbuildinfo")) {
      add(
        findings,
        "build-info",
        portable(relative(root, path)),
        "TypeScript build info must not be retained",
      );
    }
  }
}

function validateExpectedPackageNames(
  actual: ReadonlyMap<string, string>,
  expected: readonly string[] | undefined,
  findings: WorkspaceFinding[],
): void {
  if (expected === undefined) {
    return;
  }
  const expectedNames = new Set(expected);
  for (const [name, path] of actual) {
    if (!expectedNames.has(name)) {
      add(
        findings,
        "unexpected-package",
        path,
        `${name} is not part of the workspace architecture`,
      );
    }
  }
  for (const name of expectedNames) {
    if (!actual.has(name)) {
      add(
        findings,
        "missing-package",
        "package.json",
        `workspace is missing ${name}`,
      );
    }
  }
}

async function validateRootSourceIsolation(
  root: string,
  packageRoots: readonly string[],
  findings: WorkspaceFinding[],
): Promise<void> {
  const excluded = new Set([".git", "dist", "node_modules", "plugins"]);
  for (const path of await listFiles(root, excluded)) {
    if (
      SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) &&
      !packageRoots.some((packageRoot) => inside(packageRoot, path))
    ) {
      add(
        findings,
        "root-source",
        portable(relative(root, path)),
        "TypeScript production and test sources must be owned by a workspace package",
      );
    }
  }
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  return (await listFiles(root, new Set(["dist", "node_modules"]))).filter(
    (path) => SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))),
  );
}

async function listFiles(
  root: string,
  excluded: ReadonlySet<string>,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return files;
}

async function readJson(
  path: string,
  findings: WorkspaceFinding[],
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    add(
      findings,
      "invalid-json",
      portable(path),
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
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      return undefined;
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

function dependencyName(specifier: string): string | undefined {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    return undefined;
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

function add(
  findings: WorkspaceFinding[],
  code: string,
  path: string,
  message: string,
): void {
  findings.push({ code, path, message });
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function compareFindings(
  left: WorkspaceFinding,
  right: WorkspaceFinding,
): number {
  return `${left.path}\0${left.code}`.localeCompare(
    `${right.path}\0${right.code}`,
    "en",
  );
}
