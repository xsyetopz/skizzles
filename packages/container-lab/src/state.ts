import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { composeCommandArgs, internalImageTag } from "./compose.ts";
import { type DeclaredPort, type LabConfig, manifestName } from "./config.ts";
import { safeStateName, writeJsonAtomic } from "./files.ts";
import {
  assertRealDirectoryInside,
  assertRealFileInside,
  type ExactDirectoryChainOptions,
  exactDirectoryChain as inspectExactDirectoryChain,
  readTrustedDirectory,
  readTrustedUnknownJson,
  realDirectory,
} from "./trusted-filesystem.ts";
import type {
  LabMetadata,
  OwnerManifest,
  PersistedLabRuntime,
} from "./types.ts";

export type StateRoots = { stateRoot: string; runtimeRoot: string };
export type ReapedOwnerManifest = {
  version: 1;
  owner: string;
  ownerKey: string;
  reapedAt: string;
};

const LAB_STATES = new Set(["provisioning", "ready", "failed", "destroying"]);
const LAB_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REPOSITORY_HASH = /^[a-f0-9]{12}$/;
const COMPOSE_PROJECT = /^ccl-[a-z0-9][a-z0-9-]{0,62}$/;
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*$/;
const FINDING_SURFACES = new Set([
  "host-bind",
  "socket-bind",
  "privileged",
  "host-namespace",
  "device",
  "capability",
  "secret",
  "config",
  "fixed-port",
  "non-loopback-port",
]);

export async function exactDirectoryChain(
  root: string,
  segments: readonly string[],
  label: string,
  options: ExactDirectoryChainOptions = {},
): Promise<boolean> {
  return await inspectExactDirectoryChain(root, segments, label, options);
}

export async function assertOwnerStateDirectory(
  stateRoot: string,
  ownerKey: string,
  missingMessage: string,
  options: ExactDirectoryChainOptions = {},
): Promise<void> {
  if (
    !(await exactDirectoryChain(
      stateRoot,
      ["owners", ownerKey],
      "owner state directory",
      options,
    ))
  ) {
    throw new Error(missingMessage);
  }
}

type TrustedLabRuntimeOptions = ExactDirectoryChainOptions & {
  expectedOwner?: string;
  expectedOwnerKey?: string;
  containmentMessage?: string;
};

export function assertTrustedLabRuntimeIdentity(
  roots: StateRoots,
  lab: LabMetadata,
  options: TrustedLabRuntimeOptions = {},
): void {
  const expectedOwner = options.expectedOwner ?? lab.owner;
  const expectedOwnerKey = options.expectedOwnerKey ?? ownerKey(expectedOwner);
  const expectedRuntime = expectedLabRuntimeRoot(roots, expectedOwner, lab.id);
  if (
    lab.owner !== expectedOwner ||
    lab.ownerKey !== expectedOwnerKey ||
    resolve(lab.runtimeRoot) !== expectedRuntime ||
    resolve(lab.workspace) !== join(expectedRuntime, "workspace")
  ) {
    throw new Error(
      options.containmentMessage ?? "lab runtime containment is invalid",
    );
  }
}

export async function inspectTrustedLabRuntimeDirectories(
  roots: StateRoots,
  lab: LabMetadata,
  options: TrustedLabRuntimeOptions & { inspectWorkspace?: boolean } = {},
): Promise<boolean> {
  assertTrustedLabRuntimeIdentity(roots, lab, options);
  const expectedOwner = options.expectedOwner ?? lab.owner;
  const expectedOwnerKey = options.expectedOwnerKey ?? ownerKey(expectedOwner);
  const chainOptions: ExactDirectoryChainOptions = {
    ...(options.canonicalMismatch === undefined
      ? {}
      : { canonicalMismatch: options.canonicalMismatch }),
  };
  const runtimePresent = await exactDirectoryChain(
    roots.runtimeRoot,
    [expectedOwnerKey, lab.id],
    "lab runtime directory",
    chainOptions,
  );
  if (runtimePresent && options.inspectWorkspace !== false) {
    await exactDirectoryChain(
      roots.runtimeRoot,
      [expectedOwnerKey, lab.id, "workspace"],
      "lab workspace",
      chainOptions,
    );
  }
  return runtimePresent;
}

export function defaultStateRoot(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "OpenAI",
    "codex-container-lab",
  );
}

export function defaultRuntimeRoot(): string {
  return join(tmpdir(), "codex-container-lab");
}

export function resolveRoots(
  options: { stateRoot?: string; runtimeRoot?: string } = {},
): StateRoots {
  return {
    stateRoot: resolve(
      options.stateRoot ??
        process.env["CODEX_CONTAINER_LAB_STATE_ROOT"] ??
        defaultStateRoot(),
    ),
    runtimeRoot: resolve(
      options.runtimeRoot ??
        process.env["CODEX_CONTAINER_LAB_RUNTIME_ROOT"] ??
        defaultRuntimeRoot(),
    ),
  };
}

export function resolveOwner(
  explicit?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const owner = explicit ?? environment["CODEX_THREAD_ID"];
  if (owner === undefined || owner.length === 0) {
    throw new Error(
      "owner is required: pass --owner THREAD_ID or set CODEX_THREAD_ID",
    );
  }
  if (owner.includes("\0")) {
    throw new Error("owner must not contain NUL");
  }
  if (Buffer.byteLength(owner, "utf8") > 4096) {
    throw new Error("owner must be at most 4096 UTF-8 bytes");
  }
  return owner;
}

export function ownerKey(owner: string): string {
  return createHash("sha256").update(owner).digest("hex");
}

export function ownerDirectory(stateRoot: string, owner: string): string {
  return join(stateRoot, "owners", ownerKey(owner));
}

export function ownerRuntimeDirectory(
  runtimeRoot: string,
  owner: string,
): string {
  return join(runtimeRoot, ownerKey(owner));
}

export function ownerManifestPath(stateRoot: string, owner: string): string {
  return join(ownerDirectory(stateRoot, owner), "owner.json");
}

export function ownerLockPath(stateRoot: string, owner: string): string {
  return join(stateRoot, ".locks", `owner-${ownerKey(owner)}`);
}

export function labLockPath(
  stateRoot: string,
  owner: string,
  labId: string,
): string {
  safeStateName(labId, "lab id");
  return join(ownerDirectory(stateRoot, owner), ".locks", `lab-${labId}`);
}

export function activityLockPath(
  stateRoot: string,
  owner: string,
  labId: string,
): string {
  safeStateName(labId, "lab id");
  return join(ownerDirectory(stateRoot, owner), ".locks", `activity-${labId}`);
}

export function reapedOwnerPath(stateRoot: string, owner: string): string {
  return join(stateRoot, "reaped", `${ownerKey(owner)}.json`);
}

export async function readReapedOwner(
  stateRoot: string,
  owner: string,
): Promise<ReapedOwnerManifest | undefined> {
  let value: unknown;
  try {
    value = await readTrustedUnknownJson(
      stateRoot,
      ["reaped"],
      `${ownerKey(owner)}.json`,
      "reaped owner marker",
      { canonicalMismatch: "unsafe-indirection" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    value["owner"] !== owner ||
    value["ownerKey"] !== ownerKey(owner) ||
    !isTimestamp(value["reapedAt"])
  ) {
    throw new Error("invalid reaped owner manifest");
  }
  return {
    version: 1,
    owner: value["owner"],
    ownerKey: value["ownerKey"],
    reapedAt: value["reapedAt"],
  };
}

export async function markOwnerReaped(
  stateRoot: string,
  owner: string,
): Promise<ReapedOwnerManifest> {
  const existing = await readReapedOwner(stateRoot, owner);
  if (existing) {
    return existing;
  }
  const manifest: ReapedOwnerManifest = {
    version: 1,
    owner,
    ownerKey: ownerKey(owner),
    reapedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(reapedOwnerPath(stateRoot, owner), manifest);
  return manifest;
}

export function labsDirectory(stateRoot: string, owner: string): string {
  return join(ownerDirectory(stateRoot, owner), "labs");
}

export function labManifestPath(
  stateRoot: string,
  owner: string,
  labId: string,
): string {
  safeStateName(labId, "lab id");
  return join(labsDirectory(stateRoot, owner), `${labId}.json`);
}

export function expectedLabRuntimeRoot(
  roots: StateRoots,
  owner: string,
  labId: string,
): string {
  safeStateName(labId, "lab id");
  return join(resolve(roots.runtimeRoot), ownerKey(owner), labId);
}

export async function ensureOwner(
  stateRoot: string,
  owner: string,
): Promise<OwnerManifest> {
  resolveOwner(owner, {});
  const directory = ownerDirectory(stateRoot, owner);
  await mkdir(join(directory, "labs"), { recursive: true, mode: 0o700 });
  const path = ownerManifestPath(stateRoot, owner);
  try {
    const existing = await readOwnerManifest(path);
    if (existing.owner !== owner || existing.ownerKey !== ownerKey(owner)) {
      throw new Error("owner hash collision or mismatched owner manifest");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const manifest: OwnerManifest = {
    version: 1,
    owner,
    ownerKey: ownerKey(owner),
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path, manifest);
  return manifest;
}

export async function readOwnerManifest(path: string): Promise<OwnerManifest> {
  const resolvedPath = resolve(path);
  const directory = resolve(resolvedPath, "..");
  const key = basename(directory);
  const owners = resolve(directory, "..");
  if (
    basename(resolvedPath) !== "owner.json" ||
    basename(owners) !== "owners"
  ) {
    throw new Error(`invalid owner manifest path: ${path}`);
  }
  const stateRoot = resolve(owners, "..");
  const value = await readTrustedUnknownJson(
    stateRoot,
    ["owners", key],
    "owner.json",
    "owner manifest",
    { canonicalMismatch: "unsafe-indirection" },
  );
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    typeof value["owner"] !== "string" ||
    typeof value["ownerKey"] !== "string" ||
    !isTimestamp(value["createdAt"])
  ) {
    throw new Error(`invalid owner manifest: ${path}`);
  }
  resolveOwner(value["owner"], {});
  if (
    value["ownerKey"] !== ownerKey(value["owner"]) ||
    basename(resolve(path, "..")) !== value["ownerKey"]
  ) {
    throw new Error(`owner manifest hash mismatch: ${path}`);
  }
  return {
    version: 1,
    owner: value["owner"],
    ownerKey: value["ownerKey"],
    createdAt: value["createdAt"],
  };
}

export async function listOwnerManifests(
  stateRoot: string,
): Promise<Array<{ directory: string; manifest: OwnerManifest }>> {
  const root = join(stateRoot, "owners");
  const entries = await readTrustedDirectory(
    stateRoot,
    ["owners"],
    "owners state directory",
    { canonicalMismatch: "unsafe-indirection" },
  );
  if (!entries) {
    return [];
  }
  const owners: Array<{ directory: string; manifest: OwnerManifest }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new Error(`unexpected owner state entry: ${entry.name}`);
    }
    const directory = join(root, entry.name);
    const manifest = await readOwnerManifest(join(directory, "owner.json"));
    owners.push({ directory, manifest });
  }
  return owners;
}

export async function writeLab(
  roots: StateRoots,
  lab: LabMetadata,
): Promise<void> {
  assertLabMetadata(lab, roots, lab.owner, lab.id);
  await writeJsonAtomic(
    labManifestPath(roots.stateRoot, lab.owner, lab.id),
    lab,
  );
}

export async function readLab(
  roots: StateRoots,
  owner: string,
  labId: string,
): Promise<LabMetadata> {
  safeStateName(labId, "lab id");
  const value = await readTrustedUnknownJson(
    roots.stateRoot,
    ["owners", ownerKey(owner), "labs"],
    `${labId}.json`,
    "lab state file",
    { canonicalMismatch: "unsafe-indirection" },
  );
  assertLabMetadata(value, roots, owner, labId);
  return value;
}

export async function listLabs(
  roots: StateRoots,
  owner: string,
): Promise<LabMetadata[]> {
  const entries = await readTrustedDirectory(
    roots.stateRoot,
    ["owners", ownerKey(owner), "labs"],
    "lab state directory",
    { canonicalMismatch: "unsafe-indirection" },
  );
  if (!entries) {
    return [];
  }
  const labs: LabMetadata[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const name = entry.name;
    if (!name.endsWith(".json")) {
      throw new Error(`unexpected lab state entry: ${name}`);
    }
    if (!(entry.isFile() || entry.isSymbolicLink())) {
      throw new Error(`unexpected lab state entry: ${name}`);
    }
    labs.push(await readLab(roots, owner, name.slice(0, -5)));
  }
  return labs;
}

export async function removeLabState(
  stateRoot: string,
  owner: string,
  labId: string,
): Promise<void> {
  await rm(labManifestPath(stateRoot, owner, labId), { force: true });
}

export async function assertReadyLabFilesystem(
  roots: StateRoots,
  lab: LabMetadata,
): Promise<void> {
  if (lab.state !== "ready" || !lab.runtime) {
    throw new Error(`lab is not ready: ${lab.state}`);
  }
  const configuredRuntime = await realDirectory(
    roots.runtimeRoot,
    "configured runtime root",
  );
  const ownerRuntime = await realDirectory(
    join(roots.runtimeRoot, lab.ownerKey),
    "owner runtime root",
  );
  const runtime = await realDirectory(lab.runtimeRoot, "lab runtime root");
  const workspace = await realDirectory(lab.workspace, "lab workspace");
  if (
    ownerRuntime !== join(configuredRuntime, lab.ownerKey) ||
    runtime !== join(ownerRuntime, lab.id) ||
    workspace !== join(runtime, "workspace")
  ) {
    throw new Error(
      "runtime or workspace resolved outside the configured runtime root",
    );
  }
  const source = await realDirectory(lab.sourceRoot, "lab source root");
  await assertRealFileInside(source, lab.manifestPath, "lab manifest");
  await assertRealFileInside(
    runtime,
    lab.runtime.overrideFile,
    "Compose override",
  );
  if (lab.runtime.baseFile) {
    await assertRealFileInside(
      runtime,
      lab.runtime.baseFile,
      "internal Compose base",
    );
  }
  const mode = lab.runtime.config.mode;
  if (mode.kind === "compose") {
    for (const path of mode.files) {
      await assertRealFileInside(source, path, "project Compose file");
    }
  } else if (mode.kind === "dockerfile") {
    await assertRealFileInside(source, mode.dockerfile, "project Dockerfile");
    await assertRealDirectoryInside(source, mode.context, "Dockerfile context");
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive control flow is outside this type-and-lint baseline migration.
export function assertLabMetadata(
  value: unknown,
  roots: StateRoots,
  owner: string,
  labId: string,
): asserts value is LabMetadata {
  try {
    safeStateName(labId, "lab id");
    resolveOwner(owner, {});
    if (
      !isRecord(value) ||
      value["version"] !== 1 ||
      value["id"] !== labId ||
      value["owner"] !== owner ||
      value["ownerKey"] !== ownerKey(owner)
    ) {
      throw new Error("identity mismatch");
    }
    normalizeSecretEnvironment(value);
    if (typeof value["name"] !== "string" || !LAB_NAME.test(value["name"])) {
      throw new Error("invalid name");
    }
    if (
      typeof value["repoHash"] !== "string" ||
      !REPOSITORY_HASH.test(value["repoHash"])
    ) {
      throw new Error("invalid repository hash");
    }
    if (
      typeof value["composeProject"] !== "string" ||
      !COMPOSE_PROJECT.test(value["composeProject"])
    ) {
      throw new Error("invalid Compose project");
    }
    if (typeof value["state"] !== "string" || !LAB_STATES.has(value["state"])) {
      throw new Error("invalid lifecycle state");
    }
    const expectedRuntime = expectedLabRuntimeRoot(roots, owner, labId);
    if (
      !isNormalizedAbsolute(value["runtimeRoot"]) ||
      value["runtimeRoot"] !== expectedRuntime
    ) {
      throw new Error("invalid runtime root");
    }
    if (value["workspace"] !== join(expectedRuntime, "workspace")) {
      throw new Error("invalid workspace root");
    }
    if (
      !isNormalizedAbsolute(value["sourceRoot"]) ||
      value["sourceRoot"] === parse(value["sourceRoot"]).root
    ) {
      throw new Error("invalid source root");
    }
    if (value["manifestPath"] !== join(value["sourceRoot"], manifestName)) {
      throw new Error("invalid source manifest relationship");
    }
    if (
      typeof value["commandService"] !== "string" ||
      !SERVICE_NAME.test(value["commandService"])
    ) {
      throw new Error("invalid command service");
    }
    if (!(isTimestamp(value["createdAt"]) && isTimestamp(value["updatedAt"]))) {
      throw new Error("invalid timestamps");
    }
    if (
      !(
        Array.isArray(value["endpoints"]) &&
        value["endpoints"].every(isEndpoint)
      )
    ) {
      throw new Error("invalid endpoints");
    }
    if (
      !(Array.isArray(value["findings"]) && value["findings"].every(isFinding))
    ) {
      throw new Error("invalid findings");
    }
    if (!isEnvironmentNames(value["secretEnvironment"])) {
      throw new Error("invalid secret environment metadata");
    }
    if (
      value["modeKind"] !== undefined &&
      value["modeKind"] !== "compose" &&
      value["modeKind"] !== "dockerfile" &&
      value["modeKind"] !== "image"
    ) {
      throw new Error("invalid mode kind");
    }
    if (
      value["error"] !== undefined &&
      !isBoundedString(value["error"], 4_000)
    ) {
      throw new Error("invalid error");
    }
    if (value["runtime"] !== undefined) {
      validatePersistedRuntime(value, value["runtime"]);
    }
    if (value["state"] === "ready" && value["runtime"] === undefined) {
      throw new Error("ready lab has no runtime");
    }
    if (value["modeKind"] === "dockerfile") {
      if (
        value["managedImage"] !==
        internalImageTag(value["ownerKey"], value["id"])
      ) {
        throw new Error("invalid managed image");
      }
    } else if (value["managedImage"] !== undefined) {
      throw new Error("unexpected managed image");
    }
  } catch (error) {
    throw new Error(`invalid lab manifest: ${labId}: ${message(error)}`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive control flow is outside this type-and-lint baseline migration.
function validatePersistedRuntime(
  lab: Record<string, unknown>,
  runtime: unknown,
): asserts runtime is PersistedLabRuntime {
  if (
    !isRecord(runtime) ||
    !hasOnlyKeys(runtime, [
      "config",
      "composeArgs",
      "baseFile",
      "overrideFile",
      "findings",
    ]) ||
    !isRecord(runtime["config"])
  ) {
    throw new Error("invalid persisted runtime");
  }
  const persistedConfig = runtime["config"];
  const config = validatedPersistedConfig(lab, persistedConfig);
  const mode = config.mode;
  const runtimeRoot = lab["runtimeRoot"];
  const composeProject = lab["composeProject"];
  if (
    !isNormalizedAbsolute(runtimeRoot) ||
    typeof composeProject !== "string" ||
    !COMPOSE_PROJECT.test(composeProject)
  ) {
    throw new Error("invalid runtime identity");
  }
  if (
    JSON.stringify(config.secretEnvironment) !==
    JSON.stringify(lab["secretEnvironment"])
  ) {
    throw new Error("secret environment metadata mismatch");
  }
  const expectedOverride = join(runtimeRoot, "override.compose.yaml");
  const expectedBase =
    mode.kind === "compose"
      ? undefined
      : join(runtimeRoot, "base.compose.yaml");
  if (
    runtime["overrideFile"] !== expectedOverride ||
    runtime["baseFile"] !== expectedBase ||
    !Array.isArray(runtime["findings"]) ||
    !runtime["findings"].every(isFinding) ||
    JSON.stringify(runtime["findings"]) !== JSON.stringify(lab["findings"])
  ) {
    throw new Error("invalid runtime files or findings");
  }
  const expectedArgs = composeCommandArgs(config, {
    projectName: composeProject,
    overrideFile: expectedOverride,
    ...(expectedBase === undefined ? {} : { baseFile: expectedBase }),
  });
  if (
    !Array.isArray(runtime["composeArgs"]) ||
    runtime["composeArgs"].length !== expectedArgs.length ||
    !runtime["composeArgs"].every((arg, index) => arg === expectedArgs[index])
  ) {
    throw new Error("invalid Compose arguments");
  }
}

function validatedPersistedConfig(
  lab: Record<string, unknown>,
  config: Record<string, unknown>,
): LabConfig {
  const sourceRoot = lab["sourceRoot"];
  const manifestPath = lab["manifestPath"];
  if (
    !(isNormalizedAbsolute(sourceRoot) && isNormalizedAbsolute(manifestPath)) ||
    config["repoRoot"] !== sourceRoot ||
    config["manifestPath"] !== manifestPath ||
    !hasOnlyKeys(config, [
      "repoRoot",
      "manifestPath",
      "mode",
      "runtime",
      "ports",
      "forwardEnvironment",
      "secretEnvironment",
    ]) ||
    !isRecord(config["mode"]) ||
    !isRecord(config["runtime"])
  ) {
    throw new Error("runtime source identity mismatch");
  }
  const mode = validatedPersistedMode(lab, sourceRoot, config["mode"]);
  const runtime = config["runtime"];
  if (
    !(
      hasOnlyKeys(runtime, ["workspace", "shell"]) &&
      isBoundedString(runtime["workspace"], 1_024) &&
      posix.isAbsolute(runtime["workspace"])
    ) ||
    posix.normalize(runtime["workspace"]) !== runtime["workspace"] ||
    runtime["workspace"] === "/" ||
    !isRuntimeShell(runtime["shell"])
  ) {
    throw new Error("invalid container runtime");
  }
  if (
    !(Array.isArray(config["ports"]) && config["ports"].every(isDeclaredPort))
  ) {
    throw new Error("invalid declared ports");
  }
  if (!isEnvironmentNames(config["forwardEnvironment"])) {
    throw new Error("invalid forwarded environment");
  }
  const forwardedEnvironment = new Set(config["forwardEnvironment"]);
  if (
    !isEnvironmentNames(config["secretEnvironment"]) ||
    config["secretEnvironment"].some((key) => forwardedEnvironment.has(key))
  ) {
    throw new Error("invalid secret environment");
  }
  return {
    repoRoot: sourceRoot,
    manifestPath,
    mode,
    runtime: {
      workspace: runtime["workspace"],
      shell: [...runtime["shell"]],
    },
    ports: config["ports"].map((port) => ({ ...port })),
    forwardEnvironment: [...config["forwardEnvironment"]],
    secretEnvironment: [...config["secretEnvironment"]],
  };
}

function validatedPersistedMode(
  lab: Record<string, unknown>,
  sourceRoot: string,
  mode: Record<string, unknown>,
): LabConfig["mode"] {
  if (
    mode["kind"] !== lab["modeKind"] ||
    mode["commandService"] !== lab["commandService"] ||
    typeof mode["commandService"] !== "string" ||
    !SERVICE_NAME.test(mode["commandService"])
  ) {
    throw new Error("runtime mode identity mismatch");
  }
  const commandService = mode["commandService"];
  if (mode["kind"] === "compose") {
    if (
      !(
        hasOnlyKeys(mode, ["kind", "files", "commandService"]) &&
        Array.isArray(mode["files"])
      ) ||
      mode["files"].length === 0 ||
      !mode["files"].every((path): path is string =>
        isPathInside(sourceRoot, path),
      )
    ) {
      throw new Error("invalid Compose source files");
    }
    return { kind: "compose", files: [...mode["files"]], commandService };
  }
  if (mode["kind"] === "dockerfile") {
    if (
      !(
        hasOnlyKeys(mode, [
          "kind",
          "dockerfile",
          "context",
          "commandService",
        ]) &&
        isPathInside(sourceRoot, mode["dockerfile"]) &&
        isPathInside(sourceRoot, mode["context"], true)
      )
    ) {
      throw new Error("invalid Dockerfile source paths");
    }
    return {
      kind: "dockerfile",
      dockerfile: mode["dockerfile"],
      context: mode["context"],
      commandService,
    };
  }
  if (mode["kind"] === "image") {
    if (
      !(
        hasOnlyKeys(mode, ["kind", "image", "commandService"]) &&
        isBoundedString(mode["image"], 1_024)
      ) ||
      mode["image"].includes("\0") ||
      mode["image"].trim() !== mode["image"]
    ) {
      throw new Error("invalid image name");
    }
    return { kind: "image", image: mode["image"], commandService };
  }
  throw new Error("invalid runtime mode");
}

function normalizeSecretEnvironment(lab: Record<string, unknown>): void {
  let runtimeNames: unknown;
  if (isRecord(lab["runtime"]) && isRecord(lab["runtime"]["config"])) {
    if (lab["runtime"]["config"]["secretEnvironment"] === undefined) {
      lab["runtime"]["config"]["secretEnvironment"] = [];
    }
    runtimeNames = lab["runtime"]["config"]["secretEnvironment"];
  }
  if (lab["secretEnvironment"] === undefined) {
    lab["secretEnvironment"] = Array.isArray(runtimeNames)
      ? [...runtimeNames]
      : [];
  }
}

function isEnvironmentNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (key) => typeof key === "string" && ENVIRONMENT_NAME.test(key),
    ) &&
    new Set(value).size === value.length
  );
}

function isPathInside(
  root: string,
  candidate: unknown,
  allowRoot = false,
): candidate is string {
  if (typeof candidate !== "string" || !isNormalizedAbsolute(candidate)) {
    return false;
  }
  const fromRoot = relative(root, candidate);
  return (
    (allowRoot || fromRoot !== "") &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function isNormalizedAbsolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

function isEndpoint(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    SERVICE_NAME.test(value["name"]) &&
    typeof value["service"] === "string" &&
    SERVICE_NAME.test(value["service"]) &&
    typeof value["target"] === "number" &&
    Number.isInteger(value["target"]) &&
    value["target"] >= 1 &&
    value["target"] <= 65_535 &&
    isBoundedString(value["url"], 2_048)
  );
}

function isDeclaredPort(value: unknown): value is DeclaredPort {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "service", "target", "scheme"]) &&
    typeof value["name"] === "string" &&
    SERVICE_NAME.test(value["name"]) &&
    typeof value["service"] === "string" &&
    SERVICE_NAME.test(value["service"]) &&
    typeof value["target"] === "number" &&
    Number.isInteger(value["target"]) &&
    value["target"] >= 1 &&
    value["target"] <= 65_535 &&
    (value["scheme"] === undefined ||
      (typeof value["scheme"] === "string" && URL_SCHEME.test(value["scheme"])))
  );
}

function isRuntimeShell(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    value.every(
      (part) => isBoundedString(part, 4_096) && !part.includes("\0"),
    ) &&
    posix.isAbsolute(value[0]) &&
    posix.normalize(value[0]) === value[0]
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isFinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value["service"] === undefined ||
      isBoundedString(value["service"], 128)) &&
    typeof value["surface"] === "string" &&
    FINDING_SURFACES.has(value["surface"]) &&
    isBoundedString(value["detail"], 1_024)
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
