import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ContainerLabPackageError,
  stageContainerLabRuntime,
  validateContainerLabDescriptor,
  validateContainerLabRuntime,
} from "./container-lab-package.ts";
import {
  PromptPolicyPackageError,
  stagePromptPolicyPackage,
  validatePackagedPromptPolicy,
  validatePromptPolicySource,
} from "./prompt-policy-package.ts";

const PLUGIN_NAME = "skizzles";
const REPOSITORY_URL = "https://github.com/xsyetopz/skizzles";
const TEMPLATE_PATH = "packages/plugin-builder/template";
const GENERATED_PATH = `plugins/${PLUGIN_NAME}`;
const MARKETPLACE_PATH = ".agents/plugins/marketplace.json";
const CANONICAL_TREE_INPUTS = [["skills", "skills"]] as const;
const CANONICAL_FILE_INPUTS = [
  [
    "packages/container-lab/assets/integrations/container-lab.json",
    "integrations/container-lab.json",
  ],
  ["packages/command-hook/assets/hooks.json", "hooks/hooks.json"],
  [
    "packages/model-catalog/assets/com.openai.skizzles-model-catalog.plist",
    "assets/com.openai.skizzles-model-catalog.plist",
  ],
  [
    "packages/model-catalog/docs/installation.md",
    "assets/model-catalog-installation.md",
  ],
] as const;
const BUNDLED_ENTRYPOINTS = [
  {
    source: "packages/command-hook/src/manage-command-output.ts",
    packageRoot: "packages/command-hook",
    destination: "hooks/manage-command-output.ts",
    label: "command hook",
  },
  {
    source: "packages/command-supervisor/src/codex-command.ts",
    packageRoot: "packages/command-supervisor",
    destination: "runtime/codex-command.ts",
    label: "command supervisor",
  },
  {
    source: "packages/model-catalog/src/index.ts",
    packageRoot: "packages/model-catalog",
    destination: "runtime/model-catalog.ts",
    label: "model catalog",
  },
  {
    source: "packages/usage-analyzer/src/main.ts",
    packageRoot: "packages/usage-analyzer",
    destination: "scripts/analyze.ts",
    label: "usage analyzer",
  },
  {
    source: "packages/installer/src/cli.ts",
    packageRoot: "packages/installer",
    destination: "packages/installer/src/cli.ts",
    label: "installer",
  },
] as const;

const BLOCKED_NAMES = new Set([
  ".DS_Store",
  ".env",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
]);
const SKIPPED_WORKSPACE_DIRECTORIES = new Set(["dist", "node_modules"]);

const BLOCKED_SUFFIXES = [".db", ".log", ".sqlite", ".sqlite3"];
const BLOCKED_CREDENTIAL_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "service-account.json",
]);
const MACHINE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/i,
];
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLUGIN_ROOT_TOKEN = ["$", "{", "PLUGIN_ROOT", "}"].join("");
const RELATIVE_MODULE_PATTERN = /^\.\.?\//;
const INSTALLER_SMOKE_TIMEOUT_MS = 1_000;
const INSTALLER_SMOKE_TERM_GRACE_MS = 150;
const INSTALLER_SMOKE_OUTPUT_LIMIT = 8_192;
const INSTALLER_PUBLIC_USAGE_PREFIX = "usage: skizzles-installer ";
const INSTALLER_CANONICAL_SOURCE_PATH = "packages/installer/src/cli.ts";

export class PackagingError extends Error {}

export interface PackagePaths {
  repoRoot: string;
  templateRoot: string;
  generatedRoot: string;
  marketplacePath: string;
}

export function packagePaths(repoRoot = defaultRepoRoot()): PackagePaths {
  const absoluteRoot = resolve(repoRoot);
  return {
    repoRoot: absoluteRoot,
    templateRoot: join(absoluteRoot, TEMPLATE_PATH),
    generatedRoot: join(absoluteRoot, GENERATED_PATH),
    marketplacePath: join(absoluteRoot, MARKETPLACE_PATH),
  };
}

export async function stagePlugin(
  repoRoot: string,
  destination: string,
): Promise<void> {
  const paths = packagePaths(repoRoot);
  await asPackagingError(() => validatePromptPolicySource(paths.repoRoot));
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });
  await copyCanonicalTree(paths.templateRoot, destination, "plugin template");

  for (const [sourcePath, destinationPath] of CANONICAL_TREE_INPUTS) {
    const source = join(paths.repoRoot, sourcePath);
    if (!(await exists(source))) {
      continue;
    }
    await copyCanonicalTree(
      source,
      join(destination, destinationPath),
      sourcePath,
    );
  }

  for (const [sourcePath, destinationPath] of CANONICAL_FILE_INPUTS) {
    await copyCanonicalFile(
      join(paths.repoRoot, sourcePath),
      join(destination, destinationPath),
      sourcePath,
    );
  }

  for (const entrypoint of BUNDLED_ENTRYPOINTS) {
    await bundleCanonicalEntrypoint(paths.repoRoot, destination, entrypoint);
  }
  await writeInstallerRuntimeManifest(paths.repoRoot, destination);
  await validatePackagedInstallerSurface(destination);
  await validateInstallerCliHelp(join(destination, "packages/installer"));

  await asPackagingError(() =>
    stagePromptPolicyPackage(paths.repoRoot, destination),
  );

  await asPackagingError(() =>
    stageContainerLabRuntime(paths.repoRoot, destination),
  );

  await validateGeneratedPlugin(
    paths.repoRoot,
    destination,
    paths.marketplacePath,
  );
}

export async function buildPlugin(repoRoot = defaultRepoRoot()): Promise<void> {
  const paths = packagePaths(repoRoot);
  const stageParent = dirname(paths.generatedRoot);
  await mkdir(stageParent, { recursive: true });
  const stagingRoot = await mkdtemp(
    join(stageParent, `.${PLUGIN_NAME}-stage-`),
  );

  try {
    await stagePlugin(paths.repoRoot, stagingRoot);
    await rm(paths.generatedRoot, { force: true, recursive: true });
    await rename(stagingRoot, paths.generatedRoot);
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

export async function checkPlugin(repoRoot = defaultRepoRoot()): Promise<void> {
  const paths = packagePaths(repoRoot);
  const comparisonRoot = await mkdtemp(
    join(tmpdir(), `${PLUGIN_NAME}-package-check-`),
  );

  try {
    await stagePlugin(paths.repoRoot, comparisonRoot);
    await rejectFinderMetadata(paths.generatedRoot, "generated plugin");
    const drift = await compareTrees(comparisonRoot, paths.generatedRoot);
    if (drift.length > 0) {
      throw new PackagingError(
        `Generated plugin diverges from canonical sources:\n${drift
          .map((line) => `- ${line}`)
          .join("\n")}\nRun \`bun run plugin:build\`.`,
      );
    }
  } finally {
    await rm(comparisonRoot, { force: true, recursive: true });
  }
}

export async function compareTrees(
  expectedRoot: string,
  actualRoot: string,
): Promise<string[]> {
  const expectedFiles = await listFiles(expectedRoot);
  const actualFiles = await listFiles(actualRoot);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const differences: string[] = [];

  for (const path of expectedFiles) {
    if (!actualSet.has(path)) {
      differences.push(`missing ${path}`);
      continue;
    }
    const [expected, actual] = await Promise.all([
      readFile(join(expectedRoot, path)),
      readFile(join(actualRoot, path)),
    ]);
    if (!expected.equals(actual)) {
      differences.push(`changed ${path}`);
    }
    const [expectedMetadata, actualMetadata] = await Promise.all([
      lstat(join(expectedRoot, path)),
      lstat(join(actualRoot, path)),
    ]);
    if ((expectedMetadata.mode & 0o777) !== (actualMetadata.mode & 0o777)) {
      differences.push(`changed mode ${path}`);
    }
  }

  for (const path of actualFiles) {
    if (!expectedSet.has(path)) {
      differences.push(`unexpected ${path}`);
    }
  }

  return differences;
}

async function validateGeneratedPlugin(
  repoRoot: string,
  pluginRoot: string,
  marketplacePath: string,
): Promise<void> {
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = await readJsonObject(manifestPath, "plugin manifest");
  const rootPackage = await readJsonObject(
    join(repoRoot, "package.json"),
    "root package.json",
  );

  if (manifest["name"] !== PLUGIN_NAME) {
    throw new PackagingError(`Plugin manifest name must be ${PLUGIN_NAME}.`);
  }
  if (manifest["version"] !== rootPackage["version"]) {
    throw new PackagingError(
      "Plugin manifest and root package versions must match.",
    );
  }
  await validateManifest(manifest, pluginRoot);
  if ("hooks" in manifest) {
    throw new PackagingError(
      "plugin.json intentionally omits `hooks`; keep the canonical default discovery path at hooks/hooks.json.",
    );
  }

  const marketplace = await readJsonObject(
    marketplacePath,
    "marketplace metadata",
  );
  validateMarketplaceEntry(marketplace);

  const hooksPath = join(pluginRoot, "hooks", "hooks.json");
  if (await exists(hooksPath)) {
    const hooks = await readJsonObject(hooksPath, "hooks/hooks.json");
    validateHookCommands(hooks, "hooks/hooks.json");
  }

  await asPackagingError(() => validateContainerLabRuntime(pluginRoot));
  await asPackagingError(() =>
    validateContainerLabDescriptor(repoRoot, pluginRoot),
  );
  await asPackagingError(() =>
    validatePackagedPromptPolicy(repoRoot, pluginRoot),
  );
  await rejectForbiddenDistributableContent(pluginRoot);
}

async function asPackagingError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof ContainerLabPackageError ||
      error instanceof PromptPolicyPackageError
    ) {
      throw new PackagingError(error.message);
    }
    throw error;
  }
}

async function bundleCanonicalEntrypoint(
  repoRoot: string,
  pluginRoot: string,
  entrypoint: (typeof BUNDLED_ENTRYPOINTS)[number],
): Promise<void> {
  const packageRootPath = join(repoRoot, entrypoint.packageRoot);
  const sourcePath = join(repoRoot, entrypoint.source);
  await assertContainedNonSymlinkFile(packageRootPath, sourcePath);
  const packageRoot = await realpath(packageRootPath);
  const source = await realpath(sourcePath);
  const buildConfig: Bun.BuildConfig & { write: false } = {
    entrypoints: [source],
    format: "esm",
    packages: "bundle",
    plugins: [packageContainmentPlugin(packageRoot, entrypoint.label)],
    target: "bun",
    throw: false,
    write: false,
  };
  const result = await Bun.build(buildConfig);
  const output = result.outputs[0];
  if (!result.success || result.outputs.length !== 1 || output === undefined) {
    const diagnostics = result.logs.map((log) => log.message).join("; ");
    throw new PackagingError(
      `Unable to create the dependency-self-contained ${entrypoint.label} bundle${diagnostics === "" ? "." : `: ${diagnostics}`}`,
    );
  }
  const destination = join(pluginRoot, entrypoint.destination);
  await mkdir(dirname(destination), { recursive: true });
  await Bun.write(destination, output);
  await chmod(destination, 0o644);
}

function packageContainmentPlugin(
  packageRoot: string,
  label: string,
): Bun.BunPlugin {
  return {
    name: `${label.replaceAll(" ", "-")}-runtime-containment`,
    setup(build) {
      build.onResolve(
        { filter: RELATIVE_MODULE_PATTERN },
        async ({ path, resolveDir }) => {
          if (!isContainedPath(packageRoot, resolveDir)) {
            return undefined;
          }
          const resolvedPath = Bun.resolveSync(path, resolveDir);
          await assertContainedNonSymlinkFile(packageRoot, resolvedPath);
          return { path: resolvedPath };
        },
      );
    },
  };
}

function isContainedPath(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  );
}

async function writeInstallerRuntimeManifest(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  const source = await readJsonObject(
    join(repoRoot, "packages/installer/package.json"),
    "installer package manifest",
  );
  const name = source["name"];
  const version = source["version"];
  if (
    name !== "@skizzles/installer" ||
    typeof version !== "string" ||
    source["type"] !== "module"
  ) {
    throw new PackagingError(
      "Installer package manifest must identify the private ESM workspace package.",
    );
  }
  const destination = join(pluginRoot, "packages/installer/package.json");
  await mkdir(dirname(destination), { recursive: true });
  await Bun.write(
    destination,
    `${JSON.stringify({ name, version, private: true, type: "module" }, null, 2)}\n`,
  );
}

async function validatePackagedInstallerSurface(
  pluginRoot: string,
): Promise<void> {
  const files = await listFiles(join(pluginRoot, "packages/installer"));
  const expected = ["package.json", "src/cli.ts"];
  if (
    files.length !== expected.length ||
    expected.some((path, index) => files[index] !== path)
  ) {
    throw new PackagingError(
      "Packaged installer runtime must contain exactly package.json and src/cli.ts.",
    );
  }
}

async function validateInstallerCliHelp(installerRoot: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "src/cli.ts", "--help"], {
    cwd: installerRoot,
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const outputAbort = new AbortController();
  const output = Promise.all([
    readBoundedOutput(child.stdout, outputAbort.signal),
    readBoundedOutput(child.stderr, outputAbort.signal),
  ]);
  const deadline = Promise.withResolvers<"deadline">();
  const timeout = setTimeout(
    () => deadline.resolve("deadline"),
    INSTALLER_SMOKE_TIMEOUT_MS,
  );
  try {
    const completed = Promise.all([child.exited, output] as const);
    const outcome = await Promise.race([completed, deadline.promise]);
    if (outcome === "deadline") {
      throw installerValidationError();
    }
    const [exitCode, [stdout, stderr]] = outcome;
    if (
      exitCode !== 2 ||
      stdout.overflow ||
      stdout.text !== "" ||
      stderr.overflow ||
      !stderr.text.startsWith(INSTALLER_PUBLIC_USAGE_PREFIX) ||
      stderr.text.includes(INSTALLER_CANONICAL_SOURCE_PATH)
    ) {
      throw installerValidationError();
    }
  } finally {
    clearTimeout(timeout);
    outputAbort.abort();
    await terminateInstallerProcessGroup(child);
    await child.exited;
    await output;
  }
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<{ overflow: boolean; text: string }> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  const reader = stream.getReader();
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (bytes < INSTALLER_SMOKE_OUTPUT_LIMIT) {
        chunks.push(value.subarray(0, INSTALLER_SMOKE_OUTPUT_LIMIT - bytes));
      }
      bytes += value.byteLength;
      overflow ||= bytes > INSTALLER_SMOKE_OUTPUT_LIMIT;
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return {
    overflow,
    text: new TextDecoder().decode(Buffer.concat(chunks)),
  };
}

async function terminateInstallerProcessGroup(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
): Promise<void> {
  signalInstallerProcessGroup(child, "SIGTERM");
  const exitedDuringGrace = await exitsWithin(
    child.exited,
    INSTALLER_SMOKE_TERM_GRACE_MS,
  );
  signalInstallerProcessGroup(child, "SIGKILL");
  if (!exitedDuringGrace) {
    await child.exited;
  }
}

function signalInstallerProcessGroup(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return;
    }
    child.kill(signal);
  }
}

async function exitsWithin(
  exited: Promise<number>,
  milliseconds: number,
): Promise<boolean> {
  const timeout = Promise.withResolvers<false>();
  const timer = setTimeout(() => timeout.resolve(false), milliseconds);
  try {
    return await Promise.race([exited.then(() => true), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function installerValidationError(): PackagingError {
  return new PackagingError("Packaged installer runtime validation failed.");
}

async function assertContainedNonSymlinkFile(
  packageRoot: string,
  resolvedPath: string,
): Promise<void> {
  const lexicalRoot = resolve(packageRoot);
  const target = resolve(resolvedPath);
  const relativePath = relative(lexicalRoot, target);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(lexicalRoot, relativePath) !== target
  ) {
    throw new PackagingError(
      "Resolved package import escapes its source root.",
    );
  }
  const root = await realpath(lexicalRoot);
  let current = lexicalRoot;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new PackagingError("Resolved package import uses a symlink.");
    }
    const currentRealPath = await realpath(current);
    const currentRelativePath = relative(root, currentRealPath);
    if (
      currentRelativePath === ".." ||
      currentRelativePath.startsWith(`..${sep}`)
    ) {
      throw new PackagingError(
        "Resolved package import escapes its source root.",
      );
    }
  }
  if (!(await lstat(target)).isFile()) {
    throw new PackagingError("Resolved package import is not a file.");
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive control flow is outside this type-and-lint baseline migration.
async function validateManifest(
  manifest: Record<string, unknown>,
  pluginRoot: string,
): Promise<void> {
  if (
    typeof manifest["version"] !== "string" ||
    !STRICT_SEMVER.test(manifest["version"])
  ) {
    throw new PackagingError("Plugin manifest version must be strict semver.");
  }
  if (
    typeof manifest["description"] !== "string" ||
    manifest["description"].trim() === ""
  ) {
    throw new PackagingError("Plugin manifest requires a description.");
  }
  if (
    !isObject(manifest["author"]) ||
    typeof manifest["author"]["name"] !== "string" ||
    manifest["author"]["name"].trim() === ""
  ) {
    throw new PackagingError("Plugin manifest requires author.name.");
  }
  if (
    manifest["homepage"] !== REPOSITORY_URL ||
    manifest["repository"] !== REPOSITORY_URL
  ) {
    throw new PackagingError(
      `Plugin manifest homepage and repository must match ${REPOSITORY_URL}.`,
    );
  }
  const interfaceValue = manifest["interface"];
  if (!isObject(interfaceValue)) {
    throw new PackagingError("Plugin manifest requires interface metadata.");
  }
  for (const field of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
  ] as const) {
    if (
      typeof interfaceValue[field] !== "string" ||
      interfaceValue[field].trim() === ""
    ) {
      throw new PackagingError(`Plugin interface requires ${field}.`);
    }
  }
  if (
    !(
      Array.isArray(interfaceValue["capabilities"]) &&
      interfaceValue["capabilities"].every((value) => typeof value === "string")
    )
  ) {
    throw new PackagingError(
      "Plugin interface capabilities must be an array of strings.",
    );
  }
  if (
    !Array.isArray(interfaceValue["defaultPrompt"]) ||
    interfaceValue["defaultPrompt"].length > 3 ||
    !interfaceValue["defaultPrompt"].every(
      (value) => typeof value === "string" && value.length <= 128,
    )
  ) {
    throw new PackagingError(
      "Plugin interface defaultPrompt must contain at most three strings of 128 characters or fewer.",
    );
  }
  for (const field of ["composerIcon", "logo", "logoDark"] as const) {
    const value = interfaceValue[field];
    if (value === undefined) {
      continue;
    }
    if (
      typeof value !== "string" ||
      !value.startsWith("./") ||
      value.includes("..") ||
      !(await exists(join(pluginRoot, value)))
    ) {
      throw new PackagingError(
        `Plugin interface ${field} must reference an existing bundled file.`,
      );
    }
  }
}

function validateMarketplaceEntry(marketplace: Record<string, unknown>): void {
  const plugins = marketplace["plugins"];
  if (!Array.isArray(plugins)) {
    throw new PackagingError(
      "Marketplace metadata must contain a plugins array.",
    );
  }
  const entry = plugins.find(
    (candidate): candidate is Record<string, unknown> =>
      isObject(candidate) && candidate["name"] === PLUGIN_NAME,
  );
  if (entry === undefined) {
    throw new PackagingError(`Marketplace metadata is missing ${PLUGIN_NAME}.`);
  }
  const source = entry["source"];
  if (
    !isObject(source) ||
    source["source"] !== "local" ||
    source["path"] !== `./plugins/${PLUGIN_NAME}`
  ) {
    throw new PackagingError(
      "Marketplace source must be local at ./plugins/skizzles.",
    );
  }
  const policy = entry["policy"];
  if (
    !(
      isObject(policy) &&
      ["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(
        String(policy["installation"]),
      ) &&
      ["ON_INSTALL", "ON_USE"].includes(String(policy["authentication"]))
    ) ||
    typeof entry["category"] !== "string"
  ) {
    throw new PackagingError(
      "Marketplace entry must include installation, authentication, and category metadata.",
    );
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive control flow is outside this type-and-lint baseline migration.
function validateHookCommands(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateHookCommands(item, `${path}[${index}]`);
    });
    return;
  }
  if (!isObject(value)) {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (key === "command") {
      const commands =
        typeof item === "string" ? [item] : Array.isArray(item) ? item : [];
      if (
        commands.length === 0 ||
        !commands.every((command) => typeof command === "string")
      ) {
        throw new PackagingError(
          `${itemPath} must be a command string or array of command strings.`,
        );
      }
      for (const command of commands) {
        if (!command.includes(PLUGIN_ROOT_TOKEN)) {
          throw new PackagingError(
            `${itemPath} must resolve bundled commands through ${PLUGIN_ROOT_TOKEN}.`,
          );
        }
      }
    }
    validateHookCommands(item, itemPath);
  }
}

async function rejectForbiddenDistributableContent(
  pluginRoot: string,
): Promise<void> {
  for (const path of await listFiles(pluginRoot)) {
    const content = await readFile(join(pluginRoot, path));
    const text = content.toString("utf8");
    const match = MACHINE_PATH_PATTERNS.find((pattern) =>
      pattern.test(text),
    )?.exec(text)?.[0];
    if (match) {
      throw new PackagingError(
        `${path} contains machine-specific path ${match}.`,
      );
    }
  }
}

async function copyCanonicalTree(
  sourceRoot: string,
  destinationRoot: string,
  label: string,
): Promise<void> {
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    throw new PackagingError(`${label} must be a directory.`);
  }
  await mkdir(destinationRoot, { recursive: true });

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name)) {
      continue;
    }
    assertDistributableName(entry.name, `${label}/${entry.name}`);
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    const sourceMetadata = await lstat(source);
    if (sourceMetadata.isSymbolicLink()) {
      throw new PackagingError(
        `${label}/${entry.name} is a symlink; distributable inputs must be self-contained.`,
      );
    }
    if (sourceMetadata.isDirectory()) {
      await copyCanonicalTree(source, destination, `${label}/${entry.name}`);
    } else if (sourceMetadata.isFile()) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else {
      throw new PackagingError(
        `${label}/${entry.name} is not a regular file or directory.`,
      );
    }
  }
}

async function copyCanonicalFile(
  source: string,
  destination: string,
  label: string,
): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PackagingError(`${label} must be a self-contained regular file.`);
  }
  const name = source.split(sep).at(-1);
  if (name === undefined) {
    throw new PackagingError(`${label} has no distributable filename.`);
  }
  assertDistributableName(name, label);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, metadata.mode & 0o777);
}

async function rejectFinderMetadata(
  root: string,
  label: string,
): Promise<void> {
  for (const path of await listFiles(root)) {
    if (path.split("/").includes(".DS_Store")) {
      throw new PackagingError(
        `${label} contains forbidden Finder metadata at ${path}.`,
      );
    }
  }
}

function assertDistributableName(name: string, path: string): void {
  const lowerName = name.toLowerCase();
  if (
    BLOCKED_NAMES.has(name) ||
    lowerName === ".env" ||
    lowerName.startsWith(".env.") ||
    BLOCKED_CREDENTIAL_NAMES.has(lowerName) ||
    BLOCKED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))
  ) {
    throw new PackagingError(
      `${path} looks like local or live state and cannot be packaged.`,
    );
  }
}

async function listFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new PackagingError(`${root} must be a directory.`);
  }
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new PackagingError(`${path} is an unsupported symlink.`);
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath);
      } else if (metadata.isFile()) {
        files.push(path);
      } else {
        throw new PackagingError(`${path} is not a regular file or directory.`);
      }
    }
  }

  await visit(root);
  return files;
}

async function readJsonObject(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new PackagingError(
      `Unable to read ${label} at ${path}: ${String(error)}`,
    );
  }
  if (!isObject(value)) {
    throw new PackagingError(`${label} must contain a JSON object.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "build") {
    await buildPlugin();
    console.log(`Built ${GENERATED_PATH} from canonical sources.`);
    return;
  }
  if (command === "check") {
    await checkPlugin();
    console.log(`${GENERATED_PATH} matches canonical sources.`);
    return;
  }
  throw new PackagingError("Usage: skizzles-plugin-builder <build|check>");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
