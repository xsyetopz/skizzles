#!/usr/bin/env bun
// @bun

// packages/model-catalog/src/index.ts
import process3 from "process";

// packages/model-catalog/src/catalog/refresh.ts
import { join as join3, resolve as resolve2 } from "path";

// packages/model-catalog/src/codex-child.ts
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile
} from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import process from "process";

// packages/model-catalog/src/catalog/schema.ts
var LUNA_MODEL = "gpt-5.6-luna";
var REQUIRED_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  LUNA_MODEL
];
function object(value, label) {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function isJsonObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
function parseJson(contents) {
  const value = JSON.parse(contents);
  return value;
}
function parseCatalogCache(value) {
  if (!isJsonObject(value)) {
    throw new Error("model catalog cache is invalid");
  }
  try {
    const clientVersion = value["client_version"];
    const fetchedAt = value["fetched_at"];
    const modelsValue = value["models"];
    if (typeof clientVersion !== "string" || typeof fetchedAt !== "string" || !Array.isArray(modelsValue) || !modelsValue.every(isJsonObject)) {
      throw new Error("model catalog cache is invalid");
    }
    return {
      ...value,
      client_version: clientVersion,
      fetched_at: fetchedAt,
      models: modelsValue
    };
  } catch {
    throw new Error("model catalog cache is invalid");
  }
}
function catalog(value) {
  const root = object(value, "model catalog");
  const modelsValue = root["models"];
  if (!Array.isArray(modelsValue) || modelsValue.length === 0) {
    throw new Error("model catalog must contain models");
  }
  const models = modelsValue.map((model, index) => object(model, `model ${index}`));
  return { ...root, models };
}
function assertCompleteCatalog(value) {
  const root = catalog(value);
  const slugs = new Set(root.models.map((model) => model["slug"]));
  const missing = REQUIRED_MODELS.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    throw new Error(`model catalog is incomplete; missing ${missing.join(", ")}`);
  }
  return root;
}
function applyLunaV2Overlay(value) {
  const cloned = assertCompleteCatalog(structuredClone(value));
  const matches = cloned.models.filter((model) => model["slug"] === LUNA_MODEL);
  const luna = matches[0];
  if (matches.length !== 1 || luna === undefined) {
    throw new Error(`expected exactly one ${LUNA_MODEL} model, found ${matches.length}`);
  }
  if (luna["multi_agent_version"] === "v2") {
    return { catalog: cloned, overlay: "upstream-v2" };
  }
  if (luna["multi_agent_version"] !== "v1") {
    throw new Error(`${LUNA_MODEL} has unexpected multi_agent_version`);
  }
  luna["multi_agent_version"] = "v2";
  return { catalog: cloned, overlay: "applied" };
}

// packages/model-catalog/src/codex-child.ts
var SEMANTIC_VERSION = /(?<![0-9A-Za-z-])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=\s|$)/;
var CHILD_FAILURE_MESSAGES = {
  "bundled-exit": "codex bundled catalog command failed",
  "invalid-bundled-json": "codex bundled catalog returned invalid JSON",
  "invalid-preflight-json": "catalog preflight returned invalid JSON",
  lifecycle: "codex command cleanup failed",
  "preflight-exit": "catalog preflight command failed",
  spawn: "codex command could not start",
  "stderr-limit": "codex stderr exceeds its byte limit",
  "stdout-limit": "codex stdout exceeds its byte limit",
  stream: "codex command stream failed",
  timeout: "codex command timed out",
  "unsafe-binary": "codex binary must be a physical absolute regular file",
  "version-exit": "codex version command failed",
  "version-format": "codex version did not contain a valid full semantic version"
};

class CodexChildError extends Error {
  code;
  constructor(code) {
    super(CHILD_FAILURE_MESSAGES[code]);
    this.name = "CodexChildError";
    this.code = code;
  }
}
function commandEnvironment(home) {
  return {
    CODEX_HOME: home,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    TMPDIR: join(home, "tmp"),
    XDG_CACHE_HOME: join(home, "xdg-cache"),
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data")
  };
}
async function isolatedHome() {
  const physicalTemp = await realpath(tmpdir());
  const home = await mkdtemp(join(physicalTemp, "skizzles-model-catalog-"));
  for (const directory of ["tmp", "xdg-cache", "xdg-config", "xdg-data"]) {
    await mkdir(join(home, directory), { mode: 448 });
  }
  return home;
}
async function validateCodexBinary(path) {
  try {
    if (!isAbsolute(path) || await realpath(path) !== path) {
      throw new CodexChildError("unsafe-binary");
    }
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CodexChildError("unsafe-binary");
    }
  } catch (error) {
    if (error instanceof CodexChildError) {
      throw error;
    }
    throw new CodexChildError("unsafe-binary");
  }
}
function signalGroup(pid, signal) {
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw new CodexChildError("lifecycle");
  }
}
async function terminateGroup(pid, graceMs) {
  if (!signalGroup(pid, "SIGTERM")) {
    return false;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())));
    if (!signalGroup(pid, 0)) {
      return true;
    }
  }
  signalGroup(pid, "SIGKILL");
  await Bun.sleep(10);
  return true;
}
function concatenate(chunks, length) {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
async function collectBounded(stream, limit, failure, signal, stop) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  const cancel = () => {
    reader.cancel().catch(() => {
      return;
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const nextLength = length + value.byteLength;
      if (nextLength > limit) {
        stop(failure);
        break;
      }
      length = nextLength;
      chunks.push(value);
    }
  } catch {
    if (!signal.aborted) {
      stop("stream");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return concatenate(chunks, length);
}
async function runIsolatedCodex(codexBinary, argsFactory, limits) {
  await validateCodexBinary(codexBinary);
  const home = await isolatedHome();
  try {
    const args = typeof argsFactory === "function" ? await argsFactory(home) : argsFactory;
    let child;
    try {
      child = Bun.spawn([codexBinary, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: commandEnvironment(home),
        detached: true
      });
    } catch {
      throw new CodexChildError("spawn");
    }
    const controller = new AbortController;
    let failure;
    let cleanupFailed = false;
    let cleanup;
    const cleanGroup = () => {
      cleanup ??= terminateGroup(child.pid, limits.terminationGraceMs).catch(() => {
        cleanupFailed = true;
        return false;
      });
      return cleanup;
    };
    const stop = (reason) => {
      failure ??= reason;
      controller.abort();
      cleanGroup().catch(() => {
        return;
      });
    };
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    try {
      const exited = child.exited.then(async (exitCode2) => {
        if (await cleanGroup()) {
          controller.abort();
        }
        return exitCode2;
      });
      const [stdout, , exitCode] = await Promise.all([
        collectBounded(child.stdout, limits.maxStdoutBytes, "stdout-limit", controller.signal, stop),
        collectBounded(child.stderr, limits.maxStderrBytes, "stderr-limit", controller.signal, stop),
        exited
      ]);
      await cleanGroup();
      if (failure !== undefined) {
        throw new CodexChildError(failure);
      }
      if (cleanupFailed) {
        throw new CodexChildError("lifecycle");
      }
      return { stdout, exitCode };
    } finally {
      clearTimeout(timer);
      controller.abort();
      await cleanGroup();
      await child.exited.catch(() => {
        return;
      });
    }
  } catch (error) {
    if (error instanceof CodexChildError) {
      throw error;
    }
    throw new CodexChildError("lifecycle");
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {
      throw new CodexChildError("lifecycle");
    });
  }
}
function parseJsonOutput(output, failure) {
  try {
    return parseJson(new TextDecoder().decode(output));
  } catch {
    throw new CodexChildError(failure);
  }
}
async function clientVersion(codexBinary, limits) {
  const result = await runIsolatedCodex(codexBinary, ["--version"], {
    ...limits,
    maxStdoutBytes: Math.min(limits.maxStdoutBytes, 1024)
  });
  if (result.exitCode !== 0) {
    throw new CodexChildError("version-exit");
  }
  const match = new TextDecoder().decode(result.stdout).match(SEMANTIC_VERSION);
  const version = match?.[1];
  if (version === undefined) {
    throw new CodexChildError("version-format");
  }
  return version;
}
async function bundledCatalog(codexBinary, limits) {
  const result = await runIsolatedCodex(codexBinary, ["debug", "models", "--bundled"], limits);
  if (result.exitCode !== 0) {
    throw new CodexChildError("bundled-exit");
  }
  return assertCompleteCatalog(parseJsonOutput(result.stdout, "invalid-bundled-json"));
}
async function preflightCatalog(codexBinary, contents, limits) {
  const result = await runIsolatedCodex(codexBinary, async (home) => {
    const candidate = join(home, "candidate.json");
    await writeFile(candidate, contents, { mode: 384, flag: "wx" });
    return [
      "debug",
      "models",
      "-c",
      `model_catalog_json=${JSON.stringify(candidate)}`
    ];
  }, limits);
  if (result.exitCode !== 0) {
    throw new CodexChildError("preflight-exit");
  }
  const loaded = assertCompleteCatalog(parseJsonOutput(result.stdout, "invalid-preflight-json"));
  const loadedLuna = loaded.models.filter((entry) => entry["slug"] === LUNA_MODEL);
  if (loadedLuna.length !== 1 || loadedLuna[0]?.["multi_agent_version"] !== "v2") {
    throw new Error("catalog preflight did not load Luna V2");
  }
}

// packages/model-catalog/src/catalog/store.ts
import { createHash } from "crypto";
import {
  chmod,
  lstat as lstat2,
  mkdir as mkdir2,
  open,
  readFile,
  realpath as realpath2,
  rename,
  rm as rm2
} from "fs/promises";
import {
  basename,
  dirname,
  isAbsolute as isAbsolute2,
  join as join2,
  parse,
  relative,
  resolve,
  sep
} from "path";
import process2 from "process";
var MODEL_CACHE_TTL_MS = 300000;
function physicalPathKey(path) {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}
function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function identity(metadata) {
  return { dev: metadata.dev, ino: metadata.ino };
}
function sameIdentity(first, second) {
  if (first === undefined || second === undefined) {
    return first === second;
  }
  return first.dev === second.dev && first.ino === second.ino;
}
function pathComponents(path) {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const segments = absolute.slice(root.length).split(sep).filter((segment) => segment.length > 0);
  const paths = [root];
  let current = root;
  for (const segment of segments) {
    current = join2(current, segment);
    paths.push(current);
  }
  return paths;
}
async function existingPathMetadata(path) {
  try {
    return await lstat2(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }
}
async function rejectSymlinkAncestors(path) {
  for (const component of pathComponents(path)) {
    const metadata = await existingPathMetadata(component);
    if (metadata === undefined) {
      return;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${path} must not contain symlink path components`);
    }
  }
}
function within(root, path) {
  const child = relative(root, path);
  return child === "" || !child.startsWith(`..${sep}`) && child !== "..";
}
async function firstMissingComponent(path) {
  for (const component of pathComponents(path)) {
    if (await existingPathMetadata(component) === undefined) {
      return component;
    }
  }
  return;
}
async function ensureDirectoryPath(path) {
  await rejectSymlinkAncestors(path);
  for (const component of pathComponents(path)) {
    const metadata = await existingPathMetadata(component);
    if (metadata === undefined) {
      await mkdir2(component, { mode: 448 });
      const created = await lstat2(component);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error(`${component} must be a directory`);
      }
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${component} must be a directory`);
    }
  }
}
function privateMode(metadata) {
  return (metadata.mode & 511) === 448;
}
async function validatePrivateDirectoryChain(privacyRoot, directory) {
  if (!within(privacyRoot, directory)) {
    throw new Error(`${directory} escapes its private storage root`);
  }
  await rejectSymlinkAncestors(directory);
  const expectedUid = process2.getuid?.();
  for (const component of pathComponents(directory)) {
    if (!within(privacyRoot, component)) {
      continue;
    }
    const metadata = await lstat2(component);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${component} must be a directory`);
    }
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
      throw new Error(`${component} must be owned by the current user`);
    }
    if (!privateMode(metadata)) {
      throw new Error(`${component} must have mode 0700`);
    }
    if (await realpath2(component) !== component) {
      throw new Error(`${component} must use its physical path`);
    }
  }
}
async function privacyRootFor(codexHome, directory) {
  if (within(codexHome, directory)) {
    return codexHome;
  }
  return await firstMissingComponent(directory) ?? directory;
}
async function preparePrivateParent(codexHome, target) {
  const directory = dirname(target);
  const privacyRoot = await privacyRootFor(codexHome, directory);
  await ensureDirectoryPath(directory);
  await validatePrivateDirectoryChain(privacyRoot, directory);
}
async function prepareStandaloneParent(target) {
  const directory = dirname(target);
  const privacyRoot = await firstMissingComponent(directory) ?? directory;
  await ensureDirectoryPath(directory);
  await validatePrivateDirectoryChain(privacyRoot, directory);
}
async function regularFileMetadata(path) {
  const metadata = await lstat2(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${path} must not be a symlink`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${path} must be a regular file`);
  }
  return metadata;
}
function requireSingleLink(path, metadata) {
  if (metadata.nlink !== 1) {
    throw new Error(`${path} must have exactly one hard link`);
  }
  return metadata;
}
async function managedFileMetadata(path) {
  return requireSingleLink(path, await regularFileMetadata(path));
}
async function validatePhysicalRegularFile(path) {
  await rejectSymlinkAncestors(path);
  await regularFileMetadata(path);
}
async function validatePhysicalDirectory(path) {
  await rejectSymlinkAncestors(path);
  const metadata = await lstat2(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${path} must be a directory`);
  }
  if (await realpath2(path) !== path) {
    throw new Error(`${path} must use its physical path`);
  }
}
async function inspectTarget(path) {
  await rejectSymlinkAncestors(path);
  const physicalParent = await realpath2(dirname(path));
  if (physicalParent !== dirname(path)) {
    throw new Error(`${path} must use its physical parent path`);
  }
  const metadata = await existingPathMetadata(path);
  if (metadata === undefined) {
    return { physicalPath: join2(physicalParent, basename(path)) };
  }
  const regular = await managedFileMetadata(path);
  return {
    physicalPath: join2(physicalParent, basename(path)),
    identity: identity(regular),
    metadata: regular
  };
}
async function ensurePrivateFileMode(path) {
  const metadata = await existingPathMetadata(path);
  if (metadata === undefined) {
    return;
  }
  const regular = await managedFileMetadata(path);
  const expectedUid = process2.getuid?.();
  if (expectedUid !== undefined && regular.uid !== expectedUid) {
    throw new Error(`${path} must be owned by the current user`);
  }
  if ((regular.mode & 511) === 384) {
    return;
  }
  const expected = identity(regular);
  await chmod(path, 384);
  const repaired = await managedFileMetadata(path);
  if (!sameIdentity(expected, identity(repaired))) {
    throw new Error(`${path} changed during permission repair`);
  }
}
async function targetSnapshot(path) {
  const parent = await lstat2(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error(`${dirname(path)} must be a directory`);
  }
  const target = await existingPathMetadata(path);
  if (target !== undefined) {
    if (!target.isFile() || target.isSymbolicLink()) {
      throw new Error(`${path} must be a regular file`);
    }
    requireSingleLink(path, target);
  }
  return {
    parent: identity(parent),
    ...target === undefined ? {} : {
      target: identity(target),
      targetCtimeMs: target.ctimeMs,
      targetMode: target.mode & 511,
      targetMtimeMs: target.mtimeMs,
      targetNlink: target.nlink,
      targetSize: target.size
    }
  };
}
async function assertSnapshotUnchanged(path, expected) {
  await rejectSymlinkAncestors(path);
  const current = await targetSnapshot(path);
  if (!(sameIdentity(current.parent, expected.parent) && sameIdentity(current.target, expected.target)) || current.targetCtimeMs !== expected.targetCtimeMs || current.targetMode !== expected.targetMode || current.targetMtimeMs !== expected.targetMtimeMs || current.targetNlink !== expected.targetNlink || current.targetSize !== expected.targetSize) {
    throw new Error(`${path} changed during atomic replacement`);
  }
}
async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function prepareCatalogStorePaths(paths) {
  for (const path of [paths.output, paths.status, paths.cache]) {
    if (!isAbsolute2(path)) {
      throw new Error(`${path} must be absolute`);
    }
    await preparePrivateParent(paths.codexHome, path);
    await ensurePrivateFileMode(path);
  }
  await validateCatalogStorePaths(paths);
}
async function validateCatalogTarget(paths, path) {
  const directory = dirname(path);
  const privacyRoot = await privacyRootFor(paths.codexHome, directory);
  await validatePrivateDirectoryChain(privacyRoot, directory);
  const inspection = await inspectTarget(path);
  if (inspection.metadata === undefined) {
    return inspection;
  }
  const expectedUid = process2.getuid?.();
  if (expectedUid !== undefined && inspection.metadata.uid !== expectedUid || (inspection.metadata.mode & 511) !== 384) {
    throw new Error(`${path} must be an owner-only mode 0600 file`);
  }
  return inspection;
}
function assertDistinctInspections(first, second) {
  const samePath = physicalPathKey(first.physicalPath) === physicalPathKey(second.physicalPath);
  const sameFile = first.identity !== undefined && second.identity !== undefined && sameIdentity(first.identity, second.identity);
  if (samePath || sameFile) {
    throw new Error("catalog output, status, and cache paths must be physically distinct");
  }
}
async function validateCatalogStorePaths(paths) {
  const inspections = await Promise.all([paths.output, paths.status, paths.cache].map((path) => validateCatalogTarget(paths, path)));
  for (let left = 0;left < inspections.length; left += 1) {
    for (let right = left + 1;right < inspections.length; right += 1) {
      const first = inspections[left];
      const second = inspections[right];
      if (first === undefined || second === undefined) {
        continue;
      }
      assertDistinctInspections(first, second);
    }
  }
}
async function readBoundedJsonFile(path, maxBytes) {
  const metadata = await managedFileMetadata(path);
  if (metadata.size > maxBytes) {
    throw new Error("catalog input exceeds size limit");
  }
  const handle = await open(path, "r");
  try {
    const opened = requireSingleLink(path, await handle.stat());
    if (!(opened.isFile() && sameIdentity(identity(metadata), identity(opened)))) {
      throw new Error(`${path} changed while opening catalog input`);
    }
    const contents = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < contents.byteLength) {
      const { bytesRead } = await handle.read(contents, length, contents.byteLength - length, null);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > maxBytes) {
      throw new Error("catalog input exceeds size limit");
    }
    const completed = requireSingleLink(path, await handle.stat());
    if (!sameIdentity(identity(opened), identity(completed))) {
      throw new Error(`${path} changed while reading catalog input`);
    }
    return parseJson(contents.subarray(0, length).toString("utf8"));
  } finally {
    await handle.close();
  }
}
async function cachedCatalog(path, expectedVersion, now, maxBytes) {
  try {
    const root = parseCatalogCache(await readBoundedJsonFile(path, maxBytes));
    if (root.client_version !== expectedVersion) {
      return;
    }
    const fetchedAt = Date.parse(root.fetched_at);
    const age = now.getTime() - fetchedAt;
    if (!Number.isFinite(fetchedAt) || age < 0 || age > MODEL_CACHE_TTL_MS) {
      return;
    }
    return assertCompleteCatalog({ models: root.models });
  } catch {
    return;
  }
}
async function validatedAtomicParent(path) {
  if (!isAbsolute2(path)) {
    throw new Error(`${path} must be absolute`);
  }
  await prepareStandaloneParent(path);
  await rejectSymlinkAncestors(path);
  const parent = dirname(path);
  const metadata = await lstat2(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${parent} must be a directory`);
  }
  if (!privateMode(metadata)) {
    throw new Error(`${parent} must have mode 0700`);
  }
  const expectedUid = process2.getuid?.();
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error(`${parent} must be owned by the current user`);
  }
  return parent;
}
async function preparedTarget(path, contents) {
  let expected = await targetSnapshot(path);
  if (expected.target === undefined) {
    return { expected, unchanged: false };
  }
  if (expected.targetMode !== 384) {
    await chmod(path, 384);
    expected = await targetSnapshot(path);
  }
  await assertSnapshotUnchanged(path, expected);
  if (expected.targetSize !== Buffer.byteLength(contents)) {
    return { expected, unchanged: false };
  }
  const currentContents = await readFile(path, "utf8");
  await assertSnapshotUnchanged(path, expected);
  return { expected, unchanged: currentContents === contents };
}
async function writeSyncedTemporary(temporary, contents) {
  try {
    const handle = await open(temporary, "wx", 384);
    try {
      const opened = requireSingleLink(temporary, await handle.stat());
      if ((opened.mode & 511) !== 384) {
        throw new Error(`${temporary} must have mode 0600`);
      }
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      const completed = requireSingleLink(temporary, await handle.stat());
      if (!sameIdentity(identity(opened), identity(completed)) || (completed.mode & 511) !== 384) {
        throw new Error(`${temporary} changed while staging atomic output`);
      }
    } finally {
      await handle.close();
    }
    return await targetSnapshot(temporary);
  } catch (error) {
    await rm2(temporary, { force: true });
    throw error;
  }
}
async function promoteTemporary(path, parent, temporary, temporaryExpected, expected, options) {
  await assertSnapshotUnchanged(path, expected);
  await assertSnapshotUnchanged(temporary, temporaryExpected);
  await options.beforePromote?.();
  await assertSnapshotUnchanged(path, expected);
  await assertSnapshotUnchanged(temporary, temporaryExpected);
  await rename(temporary, path);
  await syncDirectory(parent);
  const promoted = await managedFileMetadata(path);
  if ((promoted.mode & 511) !== 384 || !sameIdentity(identity(promoted), temporaryExpected.target)) {
    throw new Error(`${path} must have mode 0600`);
  }
}
async function writePrivateAtomic(path, contents, options = {}) {
  const parent = await validatedAtomicParent(path);
  const target = await preparedTarget(path, contents);
  if (target.unchanged) {
    return false;
  }
  const temporary = join2(parent, `.${globalThis.crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const temporaryExpected = await writeSyncedTemporary(temporary, contents);
    created = true;
    await promoteTemporary(path, parent, temporary, temporaryExpected, target.expected, options);
    created = false;
    return true;
  } finally {
    if (created) {
      await rm2(temporary, { force: true });
    }
  }
}
function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

// packages/model-catalog/src/catalog/refresh.ts
var DEFAULT_MAX_CATALOG_BYTES = 8 * 1024 * 1024;
var DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
var DEFAULT_TIMEOUT_MS = 1e4;
var DEFAULT_TERMINATION_GRACE_MS = 100;
function resolveCatalogPaths(options) {
  const codexHome = resolve2(options.codexHome);
  const paths = {
    codexHome,
    codexBinary: resolve2(options.codexBinary),
    output: resolve2(options.output ?? join3(codexHome, "skizzles", "model-catalog.json")),
    status: resolve2(options.status ?? join3(codexHome, "skizzles", "model-catalog-status.json")),
    cache: resolve2(options.cache ?? join3(codexHome, "models_cache.json"))
  };
  const distinct = new Set([paths.output, paths.status, paths.cache]);
  if (distinct.size !== 3) {
    throw new Error("catalog output, status, and cache paths must be distinct");
  }
  return paths;
}
function commandLimits(options) {
  const limits = {
    timeoutMs: options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    terminationGraceMs: DEFAULT_TERMINATION_GRACE_MS,
    maxStdoutBytes: options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
  };
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("catalog command limits must be positive safe integers");
  }
  return limits;
}
async function preparedCatalog(paths, limits, now) {
  const version = await clientVersion(paths.codexBinary, limits);
  const cached = await cachedCatalog(paths.cache, version, now, limits.maxStdoutBytes);
  let source = cached ? "cache" : "bundled";
  let sourceCatalog = cached ?? await bundledCatalog(paths.codexBinary, limits);
  let overlaid = applyLunaV2Overlay(sourceCatalog);
  let contents = `${JSON.stringify(overlaid.catalog, null, 2)}
`;
  try {
    await preflightCatalog(paths.codexBinary, contents, limits);
  } catch (error) {
    if (source !== "cache") {
      throw error;
    }
    source = "bundled";
    sourceCatalog = await bundledCatalog(paths.codexBinary, limits);
    overlaid = applyLunaV2Overlay(sourceCatalog);
    contents = `${JSON.stringify(overlaid.catalog, null, 2)}
`;
    await preflightCatalog(paths.codexBinary, contents, limits);
  }
  return { source, contents, overlay: overlaid.overlay };
}
async function refreshCatalog(options) {
  const paths = resolveCatalogPaths(options);
  await prepareCatalogStorePaths(paths);
  const limits = commandLimits(options);
  const prepared = await preparedCatalog(paths, limits, options.now ?? new Date);
  await validateCatalogStorePaths(paths);
  const revalidatePaths = async () => validateCatalogStorePaths(paths);
  const updated = await writePrivateAtomic(paths.output, prepared.contents, {
    beforePromote: revalidatePaths
  });
  const result = {
    ok: true,
    source: prepared.source,
    updated,
    lunaOverlay: prepared.overlay,
    catalogChanged: updated,
    generation: digest(prepared.contents),
    output: paths.output
  };
  await writePrivateAtomic(paths.status, `${JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2)}
`, { beforePromote: revalidatePaths });
  return result;
}

// packages/model-catalog/src/cli.ts
import { readFile as readFile2 } from "fs/promises";
import { isAbsolute as isAbsolute4, resolve as resolve4 } from "path";

// packages/model-catalog/src/launch-agent.ts
import { isAbsolute as isAbsolute3, join as join4, resolve as resolve3 } from "path";
var UNRESOLVED_PLACEHOLDER = /__[A-Z0-9_]+__/;
function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function renderLaunchAgent(template, values) {
  const replacements = {
    __BUN_ABSOLUTE_PATH__: values.bun,
    __SCRIPT_ABSOLUTE_PATH__: values.script,
    __CODEX_HOME_ABSOLUTE_PATH__: values.codexHome,
    __CODEX_BINARY_ABSOLUTE_PATH__: values.codexBinary,
    __MODELS_CACHE_ABSOLUTE_PATH__: join4(values.codexHome, "models_cache.json")
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!isAbsolute3(value)) {
      throw new Error(`${placeholder} must be absolute`);
    }
    rendered = rendered.replaceAll(placeholder, xml(resolve3(value)));
  }
  if (UNRESOLVED_PLACEHOLDER.test(rendered)) {
    throw new Error("launch agent template contains unresolved placeholders");
  }
  return rendered;
}

// packages/model-catalog/src/cli.ts
var USAGE = "usage: skizzles-model-catalog <refresh|service|render-launch-agent> [options]";
function recordSwitch(found, flag) {
  if (found.has(flag)) {
    throw new Error(`${flag} must not be repeated`);
  }
  found.add(flag);
}
function recordValue(args, index, allowed, values) {
  const token = args[index];
  if (token === undefined) {
    return index;
  }
  if (!isValueFlag(token, allowed)) {
    throw new Error(token.startsWith("--") ? `unknown option ${token}` : `unexpected argument ${token}`);
  }
  const flag = token;
  if (values[flag] !== undefined) {
    throw new Error(`${flag} must not be repeated`);
  }
  const found = args[index + 1];
  if (found === undefined || found.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  if (found.length === 0 || !isAbsolute4(found)) {
    throw new Error(`${flag} requires a nonempty absolute path`);
  }
  values[flag] = found;
  return index + 1;
}
function isValueFlag(value, allowed) {
  for (const flag of allowed) {
    if (flag === value) {
      return true;
    }
  }
  return false;
}
function parseOptions(args, valueFlags, switches = []) {
  const allowedValues = new Set(valueFlags);
  const allowedSwitches = new Set(switches);
  const values = {};
  const foundSwitches = new Set;
  for (let index = 0;index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      break;
    }
    if (allowedSwitches.has(token)) {
      recordSwitch(foundSwitches, token);
      continue;
    }
    index = recordValue(args, index, allowedValues, values);
  }
  return { values, switches: foundSwitches };
}
function required(options, flag) {
  const found = options.values[flag];
  if (found === undefined) {
    throw new Error(`${flag} is required`);
  }
  return found;
}
function refreshOptions(parsed) {
  const output = parsed.values["--output"];
  const status = parsed.values["--status"];
  const cache = parsed.values["--cache"];
  return {
    codexHome: required(parsed, "--codex-home"),
    codexBinary: required(parsed, "--codex-binary"),
    ...output === undefined ? {} : { output },
    ...status === undefined ? {} : { status },
    ...cache === undefined ? {} : { cache }
  };
}
async function runRefresh(args, service) {
  const parsed = parseOptions(args, ["--codex-home", "--codex-binary", "--status", "--output", "--cache"], service ? [] : ["--quiet-unchanged"]);
  const options = refreshOptions(parsed);
  const paths = resolveCatalogPaths(options);
  await prepareCatalogStorePaths(paths);
  const { status } = paths;
  let result;
  try {
    result = await refreshCatalog({ ...options, status });
  } catch (error) {
    if (service) {
      const message = error instanceof CodexChildError ? `model catalog child failure: ${error.message}` : "model catalog refresh failed";
      await writePrivateAtomic(status, `${JSON.stringify({ ok: false, error: message, checkedAt: new Date().toISOString() }, null, 2)}
`, { beforePromote: async () => validateCatalogStorePaths(paths) });
    }
    throw error;
  }
  if (!service && (result.updated || !parsed.switches.has("--quiet-unchanged"))) {
    console.log(JSON.stringify(result));
  }
}
async function runRenderLaunchAgent(args) {
  const parsed = parseOptions(args, [
    "--template",
    "--output",
    "--bun",
    "--script",
    "--codex-home",
    "--codex-binary"
  ]);
  const output = required(parsed, "--output");
  const template = required(parsed, "--template");
  const bun = required(parsed, "--bun");
  const script = required(parsed, "--script");
  const codexHome = required(parsed, "--codex-home");
  const codexBinary = required(parsed, "--codex-binary");
  await Promise.all([
    validatePhysicalRegularFile(template),
    validatePhysicalRegularFile(bun),
    validatePhysicalRegularFile(script),
    validatePhysicalDirectory(codexHome),
    validatePhysicalRegularFile(codexBinary)
  ]);
  const rendered = renderLaunchAgent(await readFile2(template, "utf8"), {
    bun,
    script,
    codexHome,
    codexBinary
  });
  await writePrivateAtomic(output, rendered);
  console.log(JSON.stringify({ ok: true, output: resolve4(output) }));
}
function runModelCatalogCli(args) {
  const [command, ...options] = args;
  if (command === "refresh") {
    return runRefresh(options, false);
  }
  if (command === "service") {
    return runRefresh(options, true);
  }
  if (command === "render-launch-agent") {
    return runRenderLaunchAgent(options);
  }
  throw new Error(USAGE);
}

// packages/model-catalog/src/index.ts
function applyLunaV2Overlay2(value) {
  return applyLunaV2Overlay(value);
}
function refreshCatalog2(options) {
  return refreshCatalog(options);
}
function renderLaunchAgent2(template, values) {
  return renderLaunchAgent(template, values);
}
if (import.meta.main) {
  try {
    await runModelCatalogCli(process3.argv.slice(2));
  } catch (error) {
    if (error instanceof Error) {
      const { message } = error;
      console.error(message);
    } else {
      console.error("model catalog operation failed");
    }
    process3.exit(1);
  }
}
export {
  renderLaunchAgent2 as renderLaunchAgent,
  refreshCatalog2 as refreshCatalog,
  applyLunaV2Overlay2 as applyLunaV2Overlay
};
