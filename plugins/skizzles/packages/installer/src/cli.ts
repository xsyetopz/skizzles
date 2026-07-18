#!/usr/bin/env bun
// @bun

// packages/installer/src/cli.ts
import { isAbsolute as isAbsolute3, resolve as resolve9 } from "path";
import process4 from "process";

// packages/installer/src/config.ts
import { existsSync as existsSync3, rmSync as rmSync3 } from "fs";
import { join as join3, resolve as resolve3 } from "path";

// packages/installer/src/codex-config.ts
import {
  chmodSync as chmodSync2,
  closeSync,
  constants,
  existsSync as existsSync2,
  fstatSync,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  mkdtempSync,
  openSync,
  readFileSync as readFileSync2,
  realpathSync,
  renameSync as renameSync2,
  rmSync as rmSync2,
  writeFileSync
} from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute, join as join2, relative, resolve as resolve2, sep } from "path";

// packages/installer/src/managed-files.ts
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync
} from "fs";
import { join, resolve } from "path";
function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
function copyDirectoryExclusive(source, target, copyEntry = (from, to) => cpSync(from, to, { recursive: true })) {
  mkdirSync(target);
  try {
    chmodSync(target, lstatSync(source).mode & 4095);
    for (const name of readdirSync(source)) {
      if (name === ".DS_Store") {
        continue;
      }
      copyEntry(join(source, name), join(target, name));
    }
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
function assertManagedParentsAreReal(rootInput, managedParents) {
  const root = resolve(rootInput);
  for (const path of [
    root,
    ...managedParents.map((parent) => join(root, parent))
  ]) {
    if (pathEntryExists(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to manage through a symlinked parent: ${path}`);
    }
  }
}
function sameTree(left, right) {
  if (!(existsSync(left) && existsSync(right))) {
    return false;
  }
  const leftStat = lstatSync(left);
  const rightStat = lstatSync(right);
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return false;
  }
  if (leftStat.isDirectory() !== rightStat.isDirectory()) {
    return false;
  }
  if ((leftStat.mode & 4095) !== (rightStat.mode & 4095)) {
    return false;
  }
  if (leftStat.isDirectory()) {
    const leftNames = readdirSync(left).filter((name) => name !== ".DS_Store").sort();
    const rightNames = readdirSync(right).filter((name) => name !== ".DS_Store").sort();
    if (leftNames.join("\x00") !== rightNames.join("\x00")) {
      return false;
    }
    return leftNames.every((name) => sameTree(join(left, name), join(right, name)));
  }
  return readFileSync(left).equals(readFileSync(right));
}
function rollbackStagedMoves(moved) {
  for (const item of [...moved].reverse()) {
    if (pathEntryExists(item.to) && !pathEntryExists(item.from)) {
      renameSync(item.to, item.from);
    }
  }
}

// packages/installer/src/codex-config.ts
async function openConfigRpcSession(options) {
  const selectedHome = canonicalExistingPath(options.codexHome);
  const configPath = join2(selectedHome, "config.toml");
  if (!options.dryRun || options.rpcFactory) {
    return {
      rpc: await (options.rpcFactory ?? AppServerRpc.create)(selectedHome, options.codexBinary),
      configPath,
      cleanup: noRpcCleanup
    };
  }
  const previewHome = realpathSync(mkdtempSync(join2(tmpdir(), "skizzles-config-preview-")));
  chmodSync2(previewHome, 448);
  try {
    createConfigPreviewSnapshot(selectedHome, previewHome);
    const inner = await AppServerRpc.create(previewHome, options.codexBinary);
    return {
      rpc: new PreviewConfigRpc(inner, previewHome, selectedHome),
      configPath,
      cleanup: () => rmSync2(previewHome, { recursive: true, force: true })
    };
  } catch (error) {
    rmSync2(previewHome, { recursive: true, force: true });
    throw error;
  }
}
var PREVIEW_PROMPT_FILE_KEYS = [
  "model_instructions_file",
  "experimental_compact_prompt_file",
  "model_catalog_json"
];
var PREVIEW_NESTED_TOML_KEYS = new Set(["config_file"]);
var MAX_PREVIEW_FILE_BYTES = 16 * 1024 * 1024;
var MAX_PREVIEW_TOTAL_BYTES = 64 * 1024 * 1024;
var MAX_PREVIEW_REFERENCED_FILES = 256;
var MAX_PREVIEW_NESTED_CONFIG_DEPTH = 16;
function snapshotStat(stat) {
  const mtimeNs = statNanoseconds(stat.mtimeNs, stat.mtimeMs);
  const ctimeNs = statNanoseconds(stat.ctimeNs, stat.ctimeMs);
  return {
    path: "",
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs,
    ctimeNs
  };
}
function statNanoseconds(nanoseconds, milliseconds) {
  if (nanoseconds !== undefined) {
    return nanoseconds;
  }
  return typeof milliseconds === "bigint" ? milliseconds * 1000000n : BigInt(Math.round(milliseconds * 1e6));
}
function createConfigPreviewSnapshot(selectedHome, previewHome) {
  const configPath = join2(selectedHome, "config.toml");
  if (!pathEntryExists(configPath)) {
    return;
  }
  const configBytes = copyPrivateSnapshotFile(selectedHome, configPath, join2(previewHome, "config.toml"), "selected Codex config", MAX_PREVIEW_TOTAL_BYTES);
  const budget = {
    bytes: configBytes,
    copied: new Set([canonicalExistingPath(configPath)]),
    referencedFiles: 0
  };
  copyRelativeConfigInputs(configPath, selectedHome, previewHome, budget, 0);
}
function copyRelativeConfigInputs(documentPath, selectedHome, previewHome, budget, depth) {
  const contents = readFileSync2(join2(previewHome, safeSnapshotRelativePath(selectedHome, documentPath)), "utf8");
  let parsed;
  try {
    parsed = Bun.TOML.parse(contents);
  } catch {
    return;
  }
  for (const reference of configFileReferences(parsed)) {
    if (isAbsolute(reference.value) || isHomeRelative(reference.value)) {
      continue;
    }
    const source = resolve2(dirname(documentPath), reference.value);
    const relativePath = safeSnapshotRelativePath(selectedHome, source);
    const sourceKey = canonicalExistingPath(source);
    if (budget.copied.has(sourceKey)) {
      continue;
    }
    if (budget.referencedFiles >= MAX_PREVIEW_REFERENCED_FILES) {
      throw new Error("dry-run snapshot referenced-file limit exceeded");
    }
    if (PREVIEW_NESTED_TOML_KEYS.has(reference.key) && depth >= MAX_PREVIEW_NESTED_CONFIG_DEPTH) {
      throw new Error("dry-run snapshot nested-config depth limit exceeded");
    }
    budget.referencedFiles += 1;
    const destination = join2(previewHome, relativePath);
    const copiedBytes = copyPrivateSnapshotFile(selectedHome, source, destination, reference.key, Math.min(MAX_PREVIEW_FILE_BYTES, MAX_PREVIEW_TOTAL_BYTES - budget.bytes));
    budget.bytes += copiedBytes;
    budget.copied.add(sourceKey);
    if (PREVIEW_NESTED_TOML_KEYS.has(reference.key)) {
      copyRelativeConfigInputs(source, selectedHome, previewHome, budget, depth + 1);
    }
  }
}
function configFileReferences(value) {
  const references = [];
  if (!isPlainObject(value)) {
    return references;
  }
  addPromptFileReferences(value, references);
  const profiles = value["profiles"];
  if (isPlainObject(profiles)) {
    for (const profile of Object.values(profiles)) {
      if (isPlainObject(profile)) {
        addPromptFileReferences(profile, references);
      }
    }
  }
  const agents = value["agents"];
  if (isPlainObject(agents)) {
    for (const agent of Object.values(agents)) {
      if (isPlainObject(agent) && typeof agent["config_file"] === "string") {
        references.push({ key: "config_file", value: agent["config_file"] });
      }
    }
  }
  return references;
}
function addPromptFileReferences(config, references) {
  for (const key of PREVIEW_PROMPT_FILE_KEYS) {
    const value = config[key];
    if (typeof value === "string") {
      references.push({ key, value });
    }
  }
}
function snapshotSourceIdentities(selectedHome, source, label) {
  const relativePath = safeSnapshotRelativePath(selectedHome, source);
  const identities = [];
  let current = selectedHome;
  for (const segment of ["", ...relativePath.split(sep)]) {
    if (segment) {
      current = join2(current, segment);
    }
    let metadata;
    try {
      metadata = lstatSync2(current, { bigint: true });
    } catch {
      throw new Error(`${label} is missing from the selected Codex home`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} may not traverse a symlink`);
    }
    const identity = snapshotStat(metadata);
    identities.push({ ...identity, path: current });
  }
  if (!lstatSync2(source, { bigint: true }).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return identities;
}
function safeSnapshotRelativePath(selectedHome, source) {
  const relativePath = relative(selectedHome, source);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("selected Codex config-relative input escapes the selected home");
  }
  return relativePath;
}
function copyPrivateSnapshotFile(selectedHome, source, destination, label, maxBytes) {
  const identities = snapshotSourceIdentities(selectedHome, source, label);
  const expectedFile = identities.at(-1);
  if (!expectedFile) {
    throw new Error("config snapshot identity is empty");
  }
  const descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertSnapshotStat(opened, expectedFile, label);
    if (opened.size > BigInt(maxBytes)) {
      throw new Error("selected Codex config-relative input exceeds the dry-run snapshot limit");
    }
    assertSnapshotIdentities(identities, label);
    bytes = readFileSync2(descriptor);
    const rereadDescriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const rereadStat = fstatSync(rereadDescriptor, { bigint: true });
      assertSnapshotStat(rereadStat, expectedFile, label);
      const reread = readFileSync2(rereadDescriptor);
      if (!reread.equals(bytes)) {
        throw new Error(`${label} changed during dry-run snapshot`);
      }
    } finally {
      closeSync(rereadDescriptor);
    }
    assertSnapshotIdentities(identities, label);
  } finally {
    closeSync(descriptor);
  }
  mkdirSync2(dirname(destination), { recursive: true, mode: 448 });
  chmodSync2(dirname(destination), 448);
  writeFileSync(destination, bytes, { flag: "wx", mode: 384 });
  chmodSync2(destination, 384);
  return bytes.byteLength;
}
function metadataNanoseconds(stat, field) {
  const ns = field === "mtime" ? stat.mtimeNs : stat.ctimeNs;
  const ms = field === "mtime" ? stat.mtimeMs : stat.ctimeMs;
  return statNanoseconds(ns, ms);
}
function assertSnapshotStat(actual, expected, label) {
  if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || metadataNanoseconds(actual, "mtime") !== expected.mtimeNs || metadataNanoseconds(actual, "ctime") !== expected.ctimeNs) {
    throw new Error(`${label} changed during dry-run snapshot`);
  }
}
function assertSnapshotIdentities(identities, label) {
  for (const expected of identities) {
    let actual;
    try {
      actual = lstatSync2(expected.path, { bigint: true });
    } catch {
      throw new Error(`${label} changed during dry-run snapshot`);
    }
    if (actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || metadataNanoseconds(actual, "mtime") !== expected.mtimeNs || metadataNanoseconds(actual, "ctime") !== expected.ctimeNs) {
      throw new Error(`${label} changed during dry-run snapshot`);
    }
  }
}
function isHomeRelative(path) {
  return path === "~" || path.startsWith(`~${sep}`) || path.startsWith("~/");
}

class PreviewConfigRpc {
  inner;
  previewHome;
  selectedHome;
  constructor(inner, previewHome, selectedHome) {
    this.inner = inner;
    this.previewHome = previewHome;
    this.selectedHome = selectedHome;
  }
  async read() {
    const read = await this.inner.read();
    return parseConfigReadResponse(remapPreviewValue(read, this.previewHome, this.selectedHome));
  }
  batchWrite(_params) {
    return Promise.reject(new ConfigRpcError("transport", "dry-run preview may not write Codex configuration"));
  }
  close() {
    return this.inner.close();
  }
}
function remapPreviewValue(value, previewHome, selectedHome) {
  if (typeof value === "string") {
    if (value === previewHome) {
      return selectedHome;
    }
    if (value.startsWith(`${previewHome}${sep}`)) {
      return join2(selectedHome, relative(previewHome, value));
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapPreviewValue(item, previewHome, selectedHome));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    remapPreviewValue(child, previewHome, selectedHome)
  ]));
}
function noRpcCleanup() {}
var CONFIG_WRITE_ERROR_CODES = new Set([
  "configLayerReadonly",
  "configVersionConflict",
  "configValidationError",
  "configPathNotFound",
  "configSchemaUnknownKey",
  "userLayerNotFound"
]);
var SAFE_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/;

class ConfigRpcError extends Error {
  kind;
  code;
  constructor(kind, message, code) {
    super(message);
    this.name = "ConfigRpcError";
    this.kind = kind;
    this.code = code;
  }
}
function isConfigVersionConflict(error) {
  return error instanceof ConfigRpcError && error.kind === "conflict";
}
function safeConfigWriteError(error) {
  if (isConfigVersionConflict(error)) {
    return new ConfigRpcError("conflict", "Codex config version conflict; no config write was committed", "configVersionConflict");
  }
  if (error instanceof ConfigRpcError) {
    return error;
  }
  return new ConfigRpcError("transport", "Codex config write outcome is ambiguous; pending recovery evidence was retained");
}
function canonicalExistingPath(path) {
  const absolute = resolve2(path);
  return existsSync2(absolute) ? realpathSync(absolute) : absolute;
}
function validateCodexBinary(codexBinary) {
  if (!isAbsolute(codexBinary)) {
    throw new Error("--codex-binary must be an absolute path");
  }
  const binary = resolve2(codexBinary);
  if (!existsSync2(binary)) {
    throw new Error(`Codex binary is missing: ${binary}`);
  }
  const metadata = lstatSync2(binary);
  if (!(metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error(`Codex binary is not a file: ${binary}`);
  }
  return binary;
}
function configValueAt(root, keyPath) {
  let current = root;
  for (const segment of keyPath.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object" || !(segment in current)) {
      return { present: false, value: null };
    }
    const next = current[segment];
    if (next === undefined) {
      return { present: false, value: null };
    }
    current = next;
  }
  return { present: true, value: current };
}
function sameConfigValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function selectedUserLayer(read, configPath) {
  const expected = canonicalExistingPath(configPath);
  const layer = read.layers?.find(({ name }) => name.type === "user" && name.profile === null && name.file !== undefined && canonicalExistingPath(name.file) === expected);
  if (!layer) {
    throw new Error(`Codex did not report the selected user config layer: ${expected}`);
  }
  return layer;
}
function snapshotConfigValues(config, edits) {
  return edits.map(({ keyPath, value }) => {
    const before = configValueAt(config, keyPath);
    return {
      keyPath,
      beforePresent: before.present,
      before: before.value,
      after: value
    };
  });
}
function valuesMatchBefore(config, values) {
  return values.every(({ keyPath, beforePresent, before }) => {
    const current = configValueAt(config, keyPath);
    return current.present === beforePresent && (!beforePresent || sameConfigValue(current.value, before));
  });
}
function valuesMatchAfter(config, values) {
  return values.every(({ keyPath, after }) => {
    const current = configValueAt(config, keyPath);
    return current.present && sameConfigValue(current.value, after);
  });
}
function restoreConfigEdits(values) {
  return values.map(({ keyPath, beforePresent, before }) => ({
    keyPath,
    value: beforePresent ? before : null,
    mergeStrategy: "replace"
  }));
}
function ensurePrivateDirectory(path) {
  if (pathEntryExists(path) && lstatSync2(path).isSymbolicLink()) {
    throw new Error(`refusing to manage through a symlinked directory: ${path}`);
  }
  mkdirSync2(path, { recursive: true, mode: 448 });
  chmodSync2(path, 448);
}
function writePrivateJson(path, value, exclusive = false) {
  ensurePrivateDirectory(dirname(path));
  const contents = `${JSON.stringify(value, null, 2)}
`;
  if (exclusive) {
    writeFileSync(path, contents, { flag: "wx", mode: 384 });
    chmodSync2(path, 384);
    return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { flag: "wx", mode: 384 });
  try {
    chmodSync2(temporary, 384);
    renameSync2(temporary, path);
    chmodSync2(path, 384);
  } catch (error) {
    rmSync2(temporary, { force: true });
    throw error;
  }
}
function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    throw new Error(`invalid ${label}: ${path}`);
  }
}

class AppServerRpc {
  process;
  nextId = 1;
  pending = new Map;
  constructor(process) {
    this.process = process;
  }
  static async create(codexHome, codexBinary) {
    const process = Bun.spawn([codexBinary, "app-server"], {
      env: { ...Bun.env, CODEX_HOME: codexHome },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    const rpc = new AppServerRpc(process);
    rpc.consumeStdout();
    rpc.consumeStderr();
    try {
      await rpc.request("initialize", {
        clientInfo: {
          name: "skizzles_installer",
          title: "Skizzles Installer",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      });
      rpc.send({ method: "initialized" });
      return rpc;
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }
  async read() {
    return parseConfigReadResponse(await this.request("config/read", { includeLayers: true, cwd: null }));
  }
  async batchWrite(params) {
    return parseConfigWriteResponse(await this.request("config/batchWrite", params));
  }
  async close() {
    this.process.stdin.end();
    const exited = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(2000).then(() => false)
    ]);
    if (exited) {
      return;
    }
    this.process.kill();
    const terminated = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(1000).then(() => false)
    ]);
    if (terminated) {
      return;
    }
    this.process.kill(9);
    const killed = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(1000).then(() => false)
    ]);
    if (!killed) {
      throw new ConfigRpcError("transport", "Codex app-server did not terminate after its input was closed");
    }
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConfigRpcError("transport", `Codex app-server request timed out (${safeMethodName(method)})`));
      }, 15000);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject,
        timeout
      });
      this.send({ method, id, params });
    });
  }
  send(message) {
    this.process.stdin.write(`${JSON.stringify(message)}
`);
    this.process.stdin.flush();
  }
  async consumeStdout() {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder;
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(`
`);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        this.receive(line);
      }
    }
    const error = new ConfigRpcError("transport", "Codex app-server closed unexpectedly");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
  receive(line) {
    if (!line.trim()) {
      return;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPlainObject(value) || typeof value["id"] !== "number") {
      return;
    }
    const id = value["id"];
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    const protocolError = value["error"];
    if (isPlainObject(protocolError)) {
      pending.reject(classifyProtocolError(protocolError));
    } else {
      pending.resolve(value["result"]);
    }
  }
  async consumeStderr() {
    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      decoder.decode(value, { stream: true });
    }
  }
}
function classifyProtocolError(error) {
  const safeCode = configWriteErrorCode(error.data);
  if (safeCode === "configVersionConflict") {
    return new ConfigRpcError("conflict", "Codex config version conflict; no config write was committed", "configVersionConflict");
  }
  return new ConfigRpcError("protocol", safeCode ? `Codex app-server rejected the request (${safeCode})` : "Codex app-server rejected the request", safeCode);
}
function configWriteErrorCode(data) {
  if (!isPlainObject(data)) {
    return;
  }
  const value = data["config_write_error_code"];
  return typeof value === "string" && CONFIG_WRITE_ERROR_CODES.has(value) ? value : undefined;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseConfigReadResponse(value) {
  if (!isPlainObject(value)) {
    throw invalidConfigResponse();
  }
  const layersValue = value["layers"];
  if (layersValue !== null && !Array.isArray(layersValue)) {
    throw invalidConfigResponse();
  }
  const layers = layersValue === null ? null : layersValue.map(parseConfigLayerResponse);
  const configValue = value["config"];
  if (configValue === undefined) {
    return { layers };
  }
  if (!isJsonValue(configValue)) {
    throw invalidConfigResponse();
  }
  return { config: configValue, layers };
}
function parseConfigLayerResponse(value) {
  if (!(isPlainObject(value) && isPlainObject(value["name"]))) {
    throw invalidConfigResponse();
  }
  const nameValue = value["name"];
  const type = nameValue["type"];
  const file = nameValue["file"];
  const profile = nameValue["profile"];
  const version = value["version"];
  const config = value["config"];
  if (typeof type !== "string" || file !== undefined && typeof file !== "string" || profile !== undefined && profile !== null && typeof profile !== "string" || typeof version !== "string" || !isJsonValue(config)) {
    throw invalidConfigResponse();
  }
  const name = { type };
  if (typeof file === "string") {
    name.file = file;
  }
  if (profile === null || typeof profile === "string") {
    name.profile = profile;
  }
  return { name, version, config };
}
function parseConfigWriteResponse(value) {
  if (!isPlainObject(value) || typeof value["status"] !== "string" || typeof value["version"] !== "string" || typeof value["filePath"] !== "string") {
    throw invalidConfigResponse();
  }
  return {
    status: value["status"],
    version: value["version"],
    filePath: value["filePath"]
  };
}
function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}
function invalidConfigResponse() {
  return new ConfigRpcError("protocol", "Codex app-server returned an invalid config response");
}
function safeMethodName(method) {
  return SAFE_METHOD_PATTERN.test(method) ? method : "unknown method";
}

// packages/installer/src/config.ts
var aggressiveModeHint = "Proactive complexity-aware delegation is active. Follow $fourth-wall whenever orchestration would materially improve speed or quality.";
var rootHint = "Fourth Wall applies. Read and follow $fourth-wall before this task's first orchestration action.";
var subagentHint = "Fourth Wall applies. Read and follow $fourth-wall and the behavioral role resource named in your assignment.";
function configReceiptPath(codexHome) {
  return join3(canonicalExistingPath(codexHome), ".skizzles", "config-receipt.json");
}
function desiredConfigEdits(orchestration) {
  const edits = [
    { keyPath: "features.hooks", value: true, mergeStrategy: "replace" }
  ];
  if (orchestration === "aggressive") {
    edits.push({
      keyPath: "features.multi_agent_v2.enabled",
      value: true,
      mergeStrategy: "replace"
    }, {
      keyPath: "features.multi_agent_v2.max_concurrent_threads_per_session",
      value: 7,
      mergeStrategy: "replace"
    }, {
      keyPath: "features.multi_agent_v2.multi_agent_mode_hint_text",
      value: aggressiveModeHint,
      mergeStrategy: "replace"
    }, {
      keyPath: "features.multi_agent_v2.root_agent_usage_hint_text",
      value: rootHint,
      mergeStrategy: "replace"
    }, {
      keyPath: "features.multi_agent_v2.subagent_usage_hint_text",
      value: subagentHint,
      mergeStrategy: "replace"
    });
  }
  return edits;
}
function readReceipt(codexHome) {
  const path = configReceiptPath(codexHome);
  if (!existsSync3(path)) {
    throw new Error(`Skizzles config receipt is missing: ${path}`);
  }
  const parsed = readJsonFile(path, "Skizzles config receipt");
  const receipt = objectValue(parsed);
  if (receipt?.["version"] !== 1 || !isReceiptState(receipt["state"]) || !isOrchestrationMode(receipt["orchestration"]) || typeof receipt["codexBinary"] !== "string" || typeof receipt["configPath"] !== "string" || !Array.isArray(receipt["values"])) {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
  const values = receipt["values"].map((value) => {
    const owned = objectValue(value);
    if (typeof owned?.["keyPath"] !== "string" || typeof owned["beforePresent"] !== "boolean" || !isJsonValue2(owned["before"]) || !isJsonValue2(owned["after"])) {
      throw new Error(`invalid Skizzles config receipt: ${path}`);
    }
    return {
      keyPath: owned["keyPath"],
      beforePresent: owned["beforePresent"],
      before: owned["before"],
      after: owned["after"]
    };
  });
  return {
    version: 1,
    state: receipt["state"],
    orchestration: receipt["orchestration"],
    codexBinary: receipt["codexBinary"],
    configPath: receipt["configPath"],
    values
  };
}
function isReceiptState(value) {
  return value === "pending" || value === "active" || value === "restoring";
}
function isOrchestrationMode(value) {
  return value === "aggressive" || value === "passive";
}
function objectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function isJsonValue2(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue2);
  }
  const object = objectValue(value);
  return object !== undefined && Object.values(object).every(isJsonValue2);
}
function validateReceiptTarget(receipt, codexHome, codexBinary) {
  if (resolve3(receipt.codexBinary) !== codexBinary) {
    throw new Error(`use the Codex binary recorded by the config receipt: ${receipt.codexBinary}`);
  }
  if (resolve3(receipt.configPath) !== join3(codexHome, "config.toml")) {
    throw new Error("config receipt points outside the selected CODEX_HOME");
  }
}
function receiptConfigEdits(receipt) {
  return receipt.values.map(({ keyPath, after }) => ({
    keyPath,
    value: after,
    mergeStrategy: "replace"
  }));
}
function pendingConfigureReceipt(receiptPath, codexHome, codexBinary, orchestration) {
  if (!pathEntryExists(receiptPath)) {
    return;
  }
  const receipt = readReceipt(codexHome);
  validateReceiptTarget(receipt, codexHome, codexBinary);
  if (receipt.state === "active") {
    throw new Error(`Skizzles config receipt already exists: ${receiptPath}`);
  }
  if (receipt.state === "restoring") {
    throw new Error("Skizzles config restoration is pending; run unconfigure before configuring again");
  }
  if (receipt.orchestration !== orchestration) {
    throw new Error("pending config recovery uses a different orchestration mode; use the recorded mode or run unconfigure");
  }
  return receipt;
}
async function writeConfigBatch(rpc, edits, filePath, expectedVersion, conflictReceiptPath) {
  try {
    await rpc.batchWrite({
      edits,
      filePath,
      expectedVersion,
      reloadUserConfig: true
    });
  } catch (error) {
    if (conflictReceiptPath && isConfigVersionConflict(error)) {
      rmSync3(conflictReceiptPath, { force: true });
    }
    throw safeConfigWriteError(error);
  }
}
async function recoverPendingConfigure(receipt, receiptPath, config, expectedVersion, rpc, dryRun) {
  const atAfter = valuesMatchAfter(config, receipt.values);
  const atBefore = valuesMatchBefore(config, receipt.values);
  if (!(atAfter || atBefore)) {
    throw new Error("refusing to recover pending configuration after owned keys drifted");
  }
  if (dryRun) {
    return receipt;
  }
  if (!atAfter) {
    await writeConfigBatch(rpc, receiptConfigEdits(receipt), receipt.configPath, expectedVersion);
  }
  receipt.state = "active";
  writePrivateJson(receiptPath, receipt);
  return receipt;
}
async function configureCodex(options) {
  const codexHome = canonicalExistingPath(options.codexHome);
  const codexBinary = validateCodexBinary(options.codexBinary);
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  const existingReceipt = pendingConfigureReceipt(receiptPath, codexHome, codexBinary, options.orchestration);
  const configPath = join3(codexHome, "config.toml");
  const rpcSession = await openConfigRpcSession({
    codexHome,
    codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    if (existingReceipt) {
      return recoverPendingConfigure(existingReceipt, receiptPath, layer.config, layer.version, rpc, options.dryRun);
    }
    const edits = desiredConfigEdits(options.orchestration);
    const receipt = {
      version: 1,
      state: "pending",
      orchestration: options.orchestration,
      codexBinary,
      configPath,
      values: snapshotConfigValues(layer.config, edits)
    };
    if (options.dryRun) {
      return receipt;
    }
    writePrivateJson(receiptPath, receipt, true);
    await writeConfigBatch(rpc, edits, configPath, layer.version, receiptPath);
    receipt.state = "active";
    writePrivateJson(receiptPath, receipt);
    return receipt;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}
async function unconfigureCodex(options) {
  const codexHome = canonicalExistingPath(options.codexHome);
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  const receipt = readReceipt(codexHome);
  const codexBinary = validateCodexBinary(options.codexBinary);
  validateReceiptTarget(receipt, codexHome, codexBinary);
  const rpcSession = await openConfigRpcSession({
    codexHome,
    codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);
    if (atBefore && (receipt.state === "pending" || receipt.state === "restoring")) {
      if (!options.dryRun) {
        rmSync3(receiptPath);
      }
      return receipt;
    }
    if (!atAfter) {
      throw new Error("refusing to restore drifted config keys");
    }
    if (options.dryRun) {
      return receipt;
    }
    receipt.state = "restoring";
    writePrivateJson(receiptPath, receipt);
    try {
      await rpc.batchWrite({
        edits: restoreConfigEdits(receipt.values),
        filePath: receipt.configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true
      });
    } catch (error) {
      throw safeConfigWriteError(error);
    }
    rmSync3(receiptPath);
    return receipt;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}

// packages/installer/src/core.ts
import {
  existsSync as existsSync4,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync3,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  readlinkSync,
  renameSync as renameSync3,
  rmSync as rmSync4,
  symlinkSync,
  writeFileSync as writeFileSync2
} from "fs";
import { dirname as dirname2, join as join4, relative as relative2, resolve as resolve4 } from "path";
import process from "process";
var receiptName = "skills-receipt.json";
function skillsReceiptPath(codexHome) {
  return join4(resolve4(codexHome), ".skizzles", receiptName);
}
function publicSkills(sourceRoot) {
  const root = join4(resolve4(sourceRoot), "skills");
  if (!existsSync4(root)) {
    throw new Error(`canonical skills directory is missing: ${root}`);
  }
  return readdirSync2(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync4(join4(root, entry.name, "SKILL.md"))).map((entry) => ({ name: entry.name, source: join4(root, entry.name) })).sort((left, right) => left.name.localeCompare(right.name));
}
function readReceipt2(codexHome) {
  const path = skillsReceiptPath(codexHome);
  if (!existsSync4(path)) {
    throw new Error(`Skizzles skills receipt is missing: ${path}`);
  }
  const parsed = JSON.parse(readFileSync3(path, "utf8"));
  const value = objectValue2(parsed);
  if (value?.["version"] !== 1 || value["transfer"] !== "link" && value["transfer"] !== "copy" || typeof value["sourceRoot"] !== "string" || !Array.isArray(value["skills"])) {
    throw new Error(`invalid Skizzles skills receipt: ${path}`);
  }
  const skills = [];
  for (const item of value["skills"]) {
    const skill = objectValue2(item);
    if (typeof skill?.["name"] !== "string" || typeof skill["target"] !== "string") {
      throw new Error(`invalid Skizzles skills receipt: ${path}`);
    }
    skills.push({ name: skill["name"], target: skill["target"] });
  }
  return {
    version: 1,
    sourceRoot: value["sourceRoot"],
    transfer: value["transfer"],
    skills
  };
}
function objectValue2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function installSkills(options) {
  const codexHome = resolve4(options.codexHome);
  const sourceRoot = resolve4(options.sourceRoot);
  assertManagedParentsAreReal(codexHome, ["skills", ".skizzles"]);
  const receiptPath = skillsReceiptPath(codexHome);
  if (pathEntryExists(receiptPath)) {
    throw new Error(`Skizzles skills receipt already exists: ${receiptPath}`);
  }
  const skills = publicSkills(sourceRoot).map(({ name, source }) => ({
    name,
    source,
    target: join4(codexHome, "skills", name)
  }));
  if (skills.length === 0) {
    throw new Error("no public skills were found");
  }
  const conflict = skills.find(({ target }) => pathEntryExists(target));
  if (conflict) {
    throw new Error(`refusing to replace existing skill: ${conflict.target}`);
  }
  const receipt = {
    version: 1,
    sourceRoot,
    transfer: options.transfer,
    skills: skills.map(({ name, target }) => ({ name, target }))
  };
  if (options.dryRun) {
    return receipt;
  }
  mkdirSync3(join4(codexHome, "skills"), { recursive: true });
  const created = [];
  try {
    for (const skill of skills) {
      if (options.transfer === "link") {
        symlinkSync(skill.source, skill.target, "dir");
      } else {
        copyDirectoryExclusive(skill.source, skill.target);
      }
      created.push(skill.target);
    }
    mkdirSync3(dirname2(receiptPath), { recursive: true });
    writeFileSync2(receiptPath, `${JSON.stringify(receipt, null, 2)}
`, {
      flag: "wx"
    });
  } catch (error) {
    for (const target of created.reverse()) {
      rmSync4(target, { recursive: true, force: true });
    }
    throw error;
  }
  return receipt;
}
function uninstallSkills(codexHomeInput, dryRun = false, move = renameSync3) {
  const codexHome = resolve4(codexHomeInput);
  assertManagedParentsAreReal(codexHome, ["skills", ".skizzles"]);
  const receipt = readReceipt2(codexHome);
  for (const skill of receipt.skills) {
    const target = resolve4(skill.target);
    const expectedParent = join4(codexHome, "skills");
    if (dirname2(target) !== expectedParent || !pathEntryExists(target)) {
      throw new Error(`owned skill target is missing or outside CODEX_HOME: ${target}`);
    }
    const source = join4(receipt.sourceRoot, "skills", skill.name);
    if (receipt.transfer === "link") {
      if (!lstatSync3(target).isSymbolicLink()) {
        throw new Error(`owned link changed type: ${target}`);
      }
      const actual = resolve4(dirname2(target), readlinkSync(target));
      if (actual !== resolve4(source)) {
        throw new Error(`owned link target drifted: ${target}`);
      }
    } else if (!sameTree(source, target)) {
      throw new Error(`owned copied skill drifted: ${target}`);
    }
  }
  if (dryRun) {
    return receipt;
  }
  const quarantine = join4(codexHome, ".skizzles", `uninstall-${crypto.randomUUID()}`);
  mkdirSync3(quarantine);
  const moved = [];
  try {
    for (const skill of receipt.skills) {
      const destination = join4(quarantine, skill.name);
      move(skill.target, destination);
      moved.push({ from: skill.target, to: destination });
    }
    const receiptPath = skillsReceiptPath(codexHome);
    const receiptDestination = join4(quarantine, receiptName);
    move(receiptPath, receiptDestination);
    moved.push({ from: receiptPath, to: receiptDestination });
  } catch (error) {
    rollbackStagedMoves(moved);
    rmSync4(quarantine, { recursive: true, force: true });
    throw error;
  }
  try {
    rmSync4(quarantine, { recursive: true, force: true });
  } catch {}
  return receipt;
}
function receiptSummary(receipt) {
  return {
    surface: "skills",
    transfer: receipt.transfer,
    sourceRoot: receipt.sourceRoot,
    skills: receipt.skills.map(({ name, target }) => ({
      name,
      target: relative2(process.cwd(), target) || target
    }))
  };
}

// packages/installer/src/doctor.ts
import {
  accessSync,
  constants as constants2,
  existsSync as existsSync6,
  lstatSync as lstatSync5,
  mkdtempSync as mkdtempSync2,
  readFileSync as readFileSync5,
  rmSync as rmSync6
} from "fs";
import { tmpdir as tmpdir2 } from "os";
import { delimiter, join as join6, resolve as resolve6 } from "path";
import process2 from "process";

// packages/installer/src/harness.ts
import {
  existsSync as existsSync5,
  lstatSync as lstatSync4,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync4,
  readlinkSync as readlinkSync2,
  renameSync as renameSync4,
  rmSync as rmSync5,
  symlinkSync as symlinkSync2,
  writeFileSync as writeFileSync3
} from "fs";
import { dirname as dirname3, join as join5, resolve as resolve5 } from "path";
function harnessReceiptPath(home) {
  return join5(resolve5(home), ".skizzles", "harness-receipt.json");
}
function pluginEntry() {
  return {
    name: "skizzles",
    source: { source: "local", path: "./plugins/skizzles" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools"
  };
}
function marketplaceWithSkizzles() {
  const marketplace = {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: []
  };
  marketplace.plugins.push(pluginEntry());
  return `${JSON.stringify(marketplace, null, 2)}
`;
}
function readReceipt3(home) {
  const path = harnessReceiptPath(home);
  if (!existsSync5(path)) {
    throw new Error(`Skizzles harness receipt is missing: ${path}`);
  }
  const parsed = JSON.parse(readFileSync4(path, "utf8"));
  const receipt = objectValue3(parsed);
  if (receipt?.["version"] !== 1 || receipt["transfer"] !== "link" && receipt["transfer"] !== "copy" || typeof receipt["sourceRoot"] !== "string" || typeof receipt["pluginTarget"] !== "string" || typeof receipt["marketplacePath"] !== "string" || typeof receipt["marketplaceAfter"] !== "string") {
    throw new Error(`invalid Skizzles harness receipt: ${path}`);
  }
  return {
    version: 1,
    sourceRoot: receipt["sourceRoot"],
    transfer: receipt["transfer"],
    pluginTarget: receipt["pluginTarget"],
    marketplacePath: receipt["marketplacePath"],
    marketplaceAfter: receipt["marketplaceAfter"]
  };
}
function objectValue3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function installHarness(options) {
  const home = resolve5(options.home);
  const sourceRoot = resolve5(options.sourceRoot);
  const pluginSource = join5(sourceRoot, "plugins", "skizzles");
  const pluginTarget = join5(home, "plugins", "skizzles");
  const marketplacePath = join5(home, ".agents", "plugins", "marketplace.json");
  const receiptPath = harnessReceiptPath(home);
  assertManagedParentsAreReal(home, [
    "plugins",
    ".agents",
    ".agents/plugins",
    ".skizzles"
  ]);
  if (!existsSync5(join5(pluginSource, ".codex-plugin", "plugin.json"))) {
    throw new Error(`generated plugin is missing: ${pluginSource}`);
  }
  if (pathEntryExists(pluginTarget)) {
    throw new Error(`refusing to replace existing plugin: ${pluginTarget}`);
  }
  if (pathEntryExists(receiptPath)) {
    throw new Error(`Skizzles harness receipt already exists: ${receiptPath}`);
  }
  if (pathEntryExists(marketplacePath)) {
    throw new Error(`isolated harness requires an absent marketplace: ${marketplacePath}`);
  }
  const marketplaceAfter = marketplaceWithSkizzles();
  const receipt = {
    version: 1,
    sourceRoot,
    transfer: options.transfer,
    pluginTarget,
    marketplacePath,
    marketplaceAfter
  };
  if (options.dryRun) {
    return receipt;
  }
  try {
    mkdirSync4(dirname3(pluginTarget), { recursive: true });
    if (options.transfer === "link") {
      symlinkSync2(pluginSource, pluginTarget, "dir");
    } else {
      copyDirectoryExclusive(pluginSource, pluginTarget);
    }
    mkdirSync4(dirname3(marketplacePath), { recursive: true });
    writeFileSync3(marketplacePath, marketplaceAfter, { flag: "wx" });
    mkdirSync4(dirname3(receiptPath), { recursive: true });
    writeFileSync3(receiptPath, `${JSON.stringify(receipt, null, 2)}
`, {
      flag: "wx"
    });
  } catch (error) {
    rmSync5(pluginTarget, { recursive: true, force: true });
    rmSync5(marketplacePath, { force: true });
    throw error;
  }
  return receipt;
}
function uninstallHarness(homeInput, dryRun = false, move = renameSync4) {
  const home = resolve5(homeInput);
  assertManagedParentsAreReal(home, [
    "plugins",
    ".agents",
    ".agents/plugins",
    ".skizzles"
  ]);
  const receipt = readReceipt3(home);
  const expectedTarget = join5(home, "plugins", "skizzles");
  const expectedMarketplace = join5(home, ".agents", "plugins", "marketplace.json");
  if (resolve5(receipt.pluginTarget) !== expectedTarget || resolve5(receipt.marketplacePath) !== expectedMarketplace) {
    throw new Error("harness receipt targets are outside the selected HOME");
  }
  if (!pathEntryExists(receipt.pluginTarget)) {
    throw new Error("owned plugin target is missing");
  }
  const pluginSource = join5(receipt.sourceRoot, "plugins", "skizzles");
  if (receipt.transfer === "link") {
    if (!lstatSync4(receipt.pluginTarget).isSymbolicLink()) {
      throw new Error("owned plugin link changed type");
    }
    const actual = resolve5(dirname3(receipt.pluginTarget), readlinkSync2(receipt.pluginTarget));
    if (actual !== resolve5(pluginSource)) {
      throw new Error("owned plugin link target drifted");
    }
  } else if (!sameTree(pluginSource, receipt.pluginTarget)) {
    throw new Error("owned copied plugin drifted");
  }
  if (!existsSync5(receipt.marketplacePath) || readFileSync4(receipt.marketplacePath, "utf8") !== receipt.marketplaceAfter) {
    throw new Error("marketplace changed after Skizzles installation");
  }
  if (dryRun) {
    return receipt;
  }
  const quarantine = join5(home, ".skizzles", `harness-uninstall-${crypto.randomUUID()}`);
  mkdirSync4(quarantine);
  const moved = [];
  try {
    for (const [from, name] of [
      [receipt.marketplacePath, "marketplace.json"],
      [receipt.pluginTarget, "plugin"],
      [harnessReceiptPath(home), "receipt.json"]
    ]) {
      const to = join5(quarantine, name);
      move(from, to);
      moved.push({ from, to });
    }
  } catch (error) {
    rollbackStagedMoves(moved);
    rmSync5(quarantine, { recursive: true, force: true });
    throw error;
  }
  try {
    rmSync5(quarantine, { recursive: true, force: true });
  } catch {}
  return receipt;
}

// packages/installer/src/doctor.ts
var COMMIT_PATTERN = /^[0-9a-f]{40}$/;
var LINE_PATTERN = /\r?\n/;
function contract(descriptorPath) {
  const path = descriptorPath ?? defaultContainerLabDescriptor();
  const value = JSON.parse(readFileSync5(path, "utf8"));
  const root = objectValue4(value);
  const binaries = objectValue4(root?.["binaries"]);
  const execution = objectValue4(root?.["execution"]);
  const ownership = objectValue4(root?.["ownership"]);
  const bundled = objectValue4(root?.["bundled"]);
  const configuredRuntime = nonEmptyString(root?.["configuredRuntime"]);
  const operational = nonEmptyString(binaries?.["operational"]);
  const reaper = nonEmptyString(binaries?.["reaper"]);
  const adminMaxBytes = execution?.["adminMaxBytes"];
  const canonicalSource = ownership?.["canonicalSource"];
  const provenanceCommit = ownership?.["provenanceCommit"];
  const operationalEntrypoint = bundled?.["operationalEntrypoint"];
  const reaperEntrypoint = bundled?.["reaperEntrypoint"];
  const launcher = bundled?.["launcher"];
  const launchAgentTemplate = bundled?.["launchAgentTemplate"];
  const documentation = bundled?.["documentation"];
  if (configuredRuntime === undefined || operational === undefined || reaper === undefined || !Number.isSafeInteger(adminMaxBytes) || typeof adminMaxBytes !== "number" || adminMaxBytes <= 0 || ownership?.["runtimeOwner"] !== "skizzles" || !relativePath(canonicalSource) || typeof provenanceCommit !== "string" || !COMMIT_PATTERN.test(provenanceCommit) || !relativePath(operationalEntrypoint) || !relativePath(reaperEntrypoint) || !relativePath(launcher) || !relativePath(launchAgentTemplate) || !Array.isArray(documentation) || documentation.length === 0 || !documentation.every(relativePath)) {
    throw new Error("Skizzles Container Lab descriptor is invalid");
  }
  return {
    configuredRuntime,
    binaries: { operational, reaper },
    execution: { adminMaxBytes },
    ownership: {
      runtimeOwner: "skizzles",
      canonicalSource,
      provenanceCommit
    },
    bundled: {
      operationalEntrypoint,
      reaperEntrypoint,
      launcher,
      launchAgentTemplate,
      documentation
    }
  };
}
function defaultContainerLabDescriptor() {
  const canonical = resolve6(import.meta.dir, "../../container-lab/assets/integrations/container-lab.json");
  return existsSync6(canonical) ? canonical : resolve6(import.meta.dir, "../../../integrations/container-lab.json");
}
function objectValue4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function relativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..");
}
function executable(name, pathValue) {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = resolve6(directory, name);
    try {
      accessSync(candidate, constants2.X_OK);
      return candidate;
    } catch {}
  }
  return;
}
function adminJson(command, args, environment, maximumBytes, timeoutMs) {
  const spawned = Bun.spawnSync({
    cmd: [...command, ...args],
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    maxBuffer: maximumBytes + 1
  });
  const output = spawned.stdout.toString();
  const errorOutput = spawned.stderr.toString();
  if (Buffer.byteLength(output, "utf8") > maximumBytes || Buffer.byteLength(errorOutput, "utf8") > maximumBytes) {
    throw new Error("external command exceeded its public output limit");
  }
  if (spawned.signalCode !== undefined && spawned.signalCode !== null) {
    throw new Error("external command exceeded its time or output limit");
  }
  if (spawned.exitCode !== 0) {
    throw new Error("external command failed");
  }
  const lines = output.trim().split(LINE_PATTERN).filter(Boolean);
  const line = lines[0];
  if (lines.length !== 1 || line === undefined) {
    throw new Error("external command did not return one JSON record");
  }
  const value = JSON.parse(line);
  const record = objectValue4(value);
  if (record === undefined) {
    throw new Error("external command returned invalid JSON");
  }
  return record;
}
function inspectContainerLab(operational, reaper, descriptor, pathValue, timeoutMs) {
  const base = {
    version: `configured-${descriptor.configuredRuntime}-unverified`
  };
  const root = mkdtempSync2(join6(tmpdir2(), "skizzles-container-lab-doctor-"));
  try {
    const environment = { PATH: pathValue, HOME: join6(root, "home") };
    const help = adminJson(operational, ["--help"], environment, descriptor.execution.adminMaxBytes, timeoutMs);
    const reaperHelp = adminJson(reaper, ["--help"], environment, descriptor.execution.adminMaxBytes, timeoutMs);
    if (typeof help["help"] !== "string" || !help["help"].includes("run --lab") || typeof reaperHelp["help"] !== "string" || !reaperHelp["help"].includes("codex-container-lab-reaper")) {
      return {
        ...base,
        installed: true,
        compatible: false,
        ready: false,
        reason: "Container Lab command fingerprint did not match"
      };
    }
    const health = adminJson(operational, [
      "--owner",
      `skizzles-doctor-${crypto.randomUUID()}`,
      "--state-root",
      join6(root, "state"),
      "--runtime-root",
      join6(root, "runtime"),
      "health"
    ], environment, descriptor.execution.adminMaxBytes, timeoutMs);
    if (health["ok"] !== true || typeof health["dockerAvailable"] !== "boolean" || typeof health["labs"] !== "number") {
      return {
        ...base,
        installed: true,
        compatible: false,
        ready: false,
        reason: "Container Lab health contract did not match"
      };
    }
    return {
      ...base,
      installed: true,
      compatible: true,
      ready: health["dockerAvailable"],
      dockerAvailable: health["dockerAvailable"],
      ...health["dockerAvailable"] ? {} : { reason: "installed but Docker is not ready" }
    };
  } catch (error) {
    const reason = error instanceof SyntaxError ? "Container Lab returned malformed JSON" : error instanceof Error ? error.message : "Container Lab doctor failed";
    return {
      ...base,
      installed: true,
      compatible: false,
      ready: false,
      reason
    };
  } finally {
    rmSync6(root, { recursive: true, force: true });
  }
}
function doctorContainerLab(pathValue = process2.env["PATH"] ?? "", descriptorPath, timeoutMs = 5000) {
  const descriptor = contract(descriptorPath);
  const operational = executable(descriptor.binaries.operational, pathValue);
  const reaper = executable(descriptor.binaries.reaper, pathValue);
  const base = {
    version: `configured-${descriptor.configuredRuntime}-unverified`
  };
  if (!(operational && reaper)) {
    return {
      ...base,
      installed: false,
      compatible: false,
      ready: false,
      reason: "optional Container Lab PATH convenience binaries are missing"
    };
  }
  return inspectContainerLab([operational], [reaper], descriptor, pathValue, timeoutMs);
}
function doctor(home, codexHome, pathValue = process2.env["PATH"] ?? "") {
  const containerLab = doctorContainerLab(pathValue);
  let skills = "absent";
  let harness = "absent";
  if (existsSync6(skillsReceiptPath(codexHome))) {
    try {
      uninstallSkills(codexHome, true);
      skills = "healthy";
    } catch {
      skills = "drifted";
    }
  }
  if (existsSync6(harnessReceiptPath(home))) {
    try {
      uninstallHarness(home, true);
      harness = "healthy";
    } catch {
      harness = "drifted";
    }
  }
  return {
    ok: (skills === "healthy" || harness === "healthy") && skills !== "drifted" && harness !== "drifted",
    installs: { skills, harness },
    containerLab
  };
}

// packages/installer/src/prompt-policy.ts
import { createHash as createHash2 } from "crypto";
import {
  chmodSync as chmodSync4,
  existsSync as existsSync8,
  lstatSync as lstatSync7,
  mkdirSync as mkdirSync6,
  readdirSync as readdirSync4,
  readFileSync as readFileSync7,
  realpathSync as realpathSync3,
  rmdirSync as rmdirSync2,
  rmSync as rmSync8,
  writeFileSync as writeFileSync5
} from "fs";
import { dirname as dirname5, isAbsolute as isAbsolute2, join as join8, relative as relative3, resolve as resolve8 } from "path";

// packages/installer/src/prompt-policy-lock.ts
import { createHash, randomUUID } from "crypto";
import {
  chmodSync as chmodSync3,
  existsSync as existsSync7,
  lstatSync as lstatSync6,
  mkdirSync as mkdirSync5,
  readdirSync as readdirSync3,
  readFileSync as readFileSync6,
  realpathSync as realpathSync2,
  renameSync as renameSync5,
  rmdirSync,
  rmSync as rmSync7,
  statSync,
  writeFileSync as writeFileSync4
} from "fs";
import { tmpdir as tmpdir3 } from "os";
import { basename, dirname as dirname4, join as join7, resolve as resolve7 } from "path";
import process3 from "process";
var LOCK_SCHEMA = "skizzles.prompt-policy-lock";
var LOCK_VERSION = 1;
var OWNER_NAME = "owner.json";
var DEFAULT_INCOMPLETE_GRACE_MS = 5000;
var TOKEN_PATTERN = /^[0-9a-f-]{36}$/;
var ORPHAN_NAME_PATTERN = /^(?:stale|release|failed)-[0-9a-f-]{36}$/;
var CREATED_AT_UNIX_MS_FIELD = "createdAtUnixMs";
var LINE_BREAK_PATTERN = /[\r\n]/;
var WHITESPACE_PATTERN = /\s+/;
var DARWIN_PS_LSTART = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/;
var DARWIN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var DARWIN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
function promptPolicyLockPath(codexHome, lockParent = defaultLockParent()) {
  const absolute = resolve7(codexHome);
  const canonical = existsSync7(absolute) ? realpathSync2(absolute) : absolute;
  const key = createHash("sha256").update(canonical).digest("hex");
  return join7(resolve7(lockParent), key);
}
async function withPromptPolicyLock(codexHome, operation, options, work) {
  const lock = await acquireLock(codexHome, operation, options);
  try {
    await options?.afterAcquire?.(lock.path);
    verifyOwnedLock(lock, "before operation preflight");
    return await work();
  } finally {
    await options?.beforeRelease?.(lock.path);
    releaseLock(lock);
  }
}
function acquireLock(codexHome, operation, options) {
  const parent = resolve7(options?.lockParent ?? defaultLockParent());
  ensureSafeParent(parent);
  const processStartIdentity = (options?.processStartIdentity ?? defaultProcessStartIdentity)(process3.pid);
  if (!validProcessStartIdentity(processStartIdentity)) {
    throw new Error("cannot establish process-start identity for prompt-policy lifecycle lock");
  }
  const owner = {
    schema: LOCK_SCHEMA,
    version: LOCK_VERSION,
    operation,
    pid: process3.pid,
    processStartIdentity,
    token: randomUUID(),
    createdAtUnixMs: Date.now()
  };
  const path = promptPolicyLockPath(codexHome, parent);
  cleanupLockOrphans(parent, path, options);
  const created = createLock(parent, path, owner);
  if (created) {
    return created;
  }
  return reclaimStaleLock(parent, path, owner, options);
}
function cleanupLockOrphans(parent, lockPath, options) {
  const prefix = `${basename(lockPath)}.`;
  const grace = options?.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS;
  for (const name of readdirSync3(parent).sort()) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const suffix = name.slice(prefix.length);
    if (!ORPHAN_NAME_PATTERN.test(suffix)) {
      throw new Error("prompt-policy lock parent contains malformed orphan state");
    }
    const path = join7(parent, name);
    const metadata = lstatSync6(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("prompt-policy lock orphan is not a safe directory");
    }
    if ((metadata.mode & 511) !== 448) {
      throw new Error("prompt-policy lock orphan must have mode 0700");
    }
    const identity = fileIdentity(path);
    const entries = readdirSync3(path).sort();
    if (entries.length > 1 || entries.length === 1 && entries[0] !== OWNER_NAME) {
      throw new Error("prompt-policy lock orphan contains unexpected entries");
    }
    const owner = entries.length === 1 ? readOwner(path) : undefined;
    if (owner) {
      assertStaleOwner(owner, options?.processStartIdentity);
    } else if (Date.now() - metadata.mtimeMs < grace) {
      throw new Error("prompt-policy lock orphan is inside its grace period");
    }
    assertIdentity(path, identity, "prompt-policy lock orphan was replaced");
    if (owner && !sameOwner(readOwner(path), owner)) {
      throw new Error("prompt-policy lock orphan ownership changed");
    }
    removeQuarantine(path, identity, owner !== undefined);
  }
}
function createLock(parent, path, owner) {
  try {
    mkdirSync5(path, { mode: 448 });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
  chmodSync3(path, 448);
  const identity = fileIdentity(path);
  try {
    writeFileSync4(join7(path, OWNER_NAME), `${JSON.stringify(owner, null, 2)}
`, {
      flag: "wx",
      mode: 384
    });
    chmodSync3(join7(path, OWNER_NAME), 384);
    const handle = { parent, path, identity, owner };
    verifyOwnedLock(handle, "initialization");
    return handle;
  } catch (error) {
    removeOwnedLockDirectory({ parent, path, identity, owner });
    throw error;
  }
}
async function reclaimStaleLock(parent, path, replacement, options) {
  const grace = options?.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 0) {
    throw new Error("prompt-policy lock grace must be a non-negative integer");
  }
  const metadata = lstatSync6(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("prompt-policy lifecycle lock is not a safe directory");
  }
  if ((metadata.mode & 511) !== 448) {
    throw new Error("prompt-policy lifecycle lock must have mode 0700");
  }
  const identity = fileIdentity(path);
  const entries = readdirSync3(path).sort();
  if (entries.length > 1 || entries.length === 1 && entries[0] !== OWNER_NAME) {
    throw new Error("prompt-policy lifecycle lock contains unexpected entries");
  }
  const owner = entries.length === 1 ? readOwner(path) : undefined;
  if (owner) {
    assertStaleOwner(owner, options?.processStartIdentity);
  } else if (Date.now() - metadata.mtimeMs < grace) {
    throw new Error("prompt-policy lifecycle lock initialization is incomplete within its grace period");
  }
  await options?.beforeStaleQuarantine?.(path);
  assertIdentity(path, identity, "prompt-policy lock changed during stale reclaim");
  if (owner) {
    const current = readOwner(path);
    if (!sameOwner(current, owner)) {
      throw new Error("prompt-policy lock ownership changed during stale reclaim");
    }
    assertStaleOwner(current, options?.processStartIdentity);
  } else if (readdirSync3(path).length > 0) {
    throw new Error("prompt-policy orphan lock acquired an owner during reclaim");
  }
  const quarantine = `${path}.stale-${replacement.token}`;
  renameSync5(path, quarantine);
  assertIdentity(quarantine, identity, "prompt-policy stale-lock quarantine identity changed");
  const acquired = createLock(parent, path, replacement);
  if (!acquired) {
    removeQuarantine(quarantine, identity, owner !== undefined);
    throw new Error("another prompt-policy operation acquired the lifecycle lock");
  }
  try {
    removeQuarantine(quarantine, identity, owner !== undefined);
  } catch (error) {
    releaseLock(acquired);
    throw error;
  }
  return acquired;
}
function releaseLock(lock) {
  verifyOwnedLock(lock, "release");
  const quarantine = `${lock.path}.release-${lock.owner.token}`;
  renameSync5(lock.path, quarantine);
  assertIdentity(quarantine, lock.identity, "prompt-policy release quarantine identity changed");
  removeQuarantine(quarantine, lock.identity, true);
  removeParentIfEmpty(lock.parent);
}
function removeOwnedLockDirectory(lock) {
  try {
    verifyOwnedLock(lock, "failed initialization cleanup");
  } catch {
    return;
  }
  const quarantine = `${lock.path}.failed-${lock.owner.token}`;
  renameSync5(lock.path, quarantine);
  removeQuarantine(quarantine, lock.identity, true);
  removeParentIfEmpty(lock.parent);
}
function removeQuarantine(path, identity, ownerExpected) {
  assertIdentity(path, identity, "prompt-policy lock quarantine was replaced");
  const entries = readdirSync3(path).sort();
  const expected = ownerExpected ? [OWNER_NAME] : [];
  if (entries.join("\x00") !== expected.join("\x00")) {
    throw new Error("prompt-policy lock quarantine contains unexpected entries");
  }
  if (ownerExpected) {
    rmSync7(join7(path, OWNER_NAME));
  }
  rmdirSync(path);
}
function verifyOwnedLock(lock, phase) {
  assertIdentity(lock.path, lock.identity, `prompt-policy lifecycle lock changed during ${phase}`);
  const metadata = lstatSync6(lock.path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 511) !== 448) {
    throw new Error(`prompt-policy lifecycle lock became unsafe during ${phase}`);
  }
  if (readdirSync3(lock.path).sort().join("\x00") !== OWNER_NAME) {
    throw new Error(`prompt-policy lifecycle lock gained unexpected entries during ${phase}`);
  }
  const owner = readOwner(lock.path);
  if (!sameOwner(owner, lock.owner)) {
    throw new Error(`prompt-policy lock ownership changed during ${phase}`);
  }
}
function readOwner(lockPath) {
  const path = join7(lockPath, OWNER_NAME);
  const metadata = lstatSync6(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("prompt-policy lock owner is not a regular file");
  }
  if ((metadata.mode & 511) !== 384) {
    throw new Error("prompt-policy lock owner must have mode 0600");
  }
  let value;
  try {
    value = JSON.parse(readFileSync6(path, "utf8"));
  } catch {
    throw new Error("prompt-policy lock owner is invalid JSON");
  }
  if (!isObject(value)) {
    throw new Error("prompt-policy lock owner is invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "schema",
    "version",
    "operation",
    "pid",
    "processStartIdentity",
    "token",
    CREATED_AT_UNIX_MS_FIELD
  ].sort();
  if (keys.join("\x00") !== expected.join("\x00")) {
    throw new Error("prompt-policy lock owner has unexpected fields");
  }
  const operation = value["operation"];
  const pid = value["pid"];
  const processStartIdentity = value["processStartIdentity"];
  const token = value["token"];
  const createdAtUnixMs = value[CREATED_AT_UNIX_MS_FIELD];
  if (value["schema"] !== LOCK_SCHEMA || value["version"] !== LOCK_VERSION || operation !== "apply" && operation !== "restore" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || !validProcessStartIdentity(processStartIdentity) || typeof token !== "string" || !TOKEN_PATTERN.test(token) || typeof createdAtUnixMs !== "number" || !Number.isSafeInteger(createdAtUnixMs) || createdAtUnixMs < 1) {
    throw new Error("prompt-policy lock owner fields are invalid");
  }
  return {
    schema: LOCK_SCHEMA,
    version: LOCK_VERSION,
    operation,
    pid,
    processStartIdentity,
    token,
    createdAtUnixMs
  };
}
function assertStaleOwner(owner, provider = defaultProcessStartIdentity) {
  if (!processExists(owner.pid)) {
    return;
  }
  const actual = provider(owner.pid);
  if (!validProcessStartIdentity(actual)) {
    throw new Error(`cannot verify prompt-policy lock process identity for pid ${owner.pid}`);
  }
  if (actual === owner.processStartIdentity) {
    throw new Error(`prompt-policy lifecycle is owned by live pid ${owner.pid} (${owner.operation})`);
  }
}
function defaultProcessStartIdentity(pid) {
  if (process3.platform === "linux") {
    try {
      const stat = readFileSync6(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) {
        return;
      }
      const fields = stat.slice(commandEnd + 1).trim().split(WHITESPACE_PATTERN);
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : undefined;
    } catch {
      return;
    }
  }
  if (process3.platform === "darwin") {
    const result = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
      env: { ...process3.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
      stdout: "pipe",
      stderr: "ignore"
    });
    if (result.exitCode !== 0) {
      return;
    }
    return normalizeDarwinProcessStart(result.stdout.toString());
  }
  return;
}
function normalizeDarwinProcessStart(output) {
  const match = DARWIN_PS_LSTART.exec(output.trim().replace(/\s+/g, " "));
  if (!match) {
    return;
  }
  const weekday = DARWIN_WEEKDAYS.indexOf(match[1] ?? "");
  const month = DARWIN_MONTHS.indexOf(match[2] ?? "");
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const year = Number(match[7]);
  if (weekday < 0 || month < 0) {
    return;
  }
  const epochMs = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(epochMs);
  if (!Number.isFinite(epochMs) || date.getUTCDay() !== weekday || date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second || date.getUTCFullYear() !== year) {
    return;
  }
  return `darwin:${epochMs / 1000}`;
}
function processExists(pid) {
  try {
    process3.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
function validProcessStartIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !LINE_BREAK_PATTERN.test(value);
}
function sameOwner(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function fileIdentity(path) {
  const metadata = lstatSync6(path);
  return { dev: metadata.dev, ino: metadata.ino };
}
function assertIdentity(path, expected, message) {
  let actual;
  try {
    actual = fileIdentity(path);
  } catch {
    throw new Error(message);
  }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(message);
  }
}
function ensureSafeParent(parent) {
  const ancestor = dirname4(parent);
  const ancestorMetadata = statSync(ancestor);
  if (!ancestorMetadata.isDirectory()) {
    throw new Error("prompt-policy lock parent ancestor is not a directory");
  }
  try {
    const metadata = lstatSync6(parent);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("prompt-policy lock parent is not a safe directory");
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    mkdirSync5(parent, { mode: 448 });
  }
  chmodSync3(parent, 448);
}
function removeParentIfEmpty(parent) {
  try {
    if (readdirSync3(parent).length === 0) {
      rmdirSync(parent);
    }
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) {
      return;
    }
    throw error;
  }
}
function defaultLockParent() {
  const uid = typeof process3.getuid === "function" ? process3.getuid() : process3.pid;
  const systemTemp = process3.platform === "win32" ? tmpdir3() : realpathSync2("/tmp");
  return join7(systemTemp, `skizzles-prompt-policy-locks-${uid}`);
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

// packages/installer/src/prompt-policy.ts
var RECEIPT_NAME = "prompt-policy-receipt.json";
var MANAGED_DIRECTORY = "prompt-policy";
var MANAGED_FILE = "skizzles-base.md";
var PROMPT_SOURCE_ROOT = "packages/prompt-layer/assets";
var PACKAGED_DESCRIPTOR_PATH = "integrations/prompt-policy.json";
var CANONICAL_DESCRIPTOR_PATH = `${PROMPT_SOURCE_ROOT}/${PACKAGED_DESCRIPTOR_PATH}`;
var POLICY_KEYS = [
  "model_instructions_file",
  "developer_instructions",
  "compact_prompt"
];
var MACHINE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/i
];
var IMMUTABLE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
var SHA256_PATTERN = /^[0-9a-f]{64}$/;
function applyPromptPolicy(options) {
  return withPromptPolicyLock(canonicalExistingPath(options.codexHome), "apply", options.lockOptions, () => applyPromptPolicyUnlocked(options));
}
async function applyPromptPolicyUnlocked(options) {
  const context = validateContext(options);
  const source = readPolicySource(options.sourceRoot);
  const receiptExists = pathEntryExists(context.receiptPath);
  const targetExists = pathEntryExists(context.managedTarget);
  if (receiptExists !== targetExists) {
    throw new Error("prompt-policy receipt/managed-target ownership is incomplete; refusing mutation");
  }
  if (receiptExists) {
    const receipt = readAndValidateReceipt(context);
    validateManagedTarget(context, receipt);
    validateSourceMatchesReceipt(source, receipt);
    if (receipt.state === "active") {
      throw new Error("prompt policy is already active");
    }
    if (receipt.state === "restoring") {
      throw new Error("prompt policy restoration is pending; run prompt-policy restore");
    }
    return resumeApply(options, context, receipt);
  }
  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const edits = policyEdits(context.managedTarget, source);
    const receipt = {
      schema: "skizzles.prompt-policy-receipt",
      version: 1,
      state: "pending",
      codexBinary: context.codexBinary,
      configPath: context.configPath,
      managedTarget: {
        path: context.managedTarget,
        sha256: source.facts.applied.sha256,
        bytes: source.facts.applied.bytes
      },
      policy: source.facts,
      values: snapshotConfigValues(layer.config, edits)
    };
    const outcome = {
      receipt,
      action: "apply",
      managedTargetClassification: "new-managed-copy"
    };
    if (options.dryRun) {
      return outcome;
    }
    const managedIdentity = createManagedTarget(context, source.applied);
    let receiptIdentity;
    try {
      writePrivateJson(context.receiptPath, receipt, true);
      receiptIdentity = fileIdentity2(context.receiptPath);
    } catch (error) {
      cleanupNewPolicyFiles(context, managedIdentity);
      throw error;
    }
    await options.afterPendingReceipt?.();
    try {
      await rpc.batchWrite({
        edits,
        filePath: context.configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true
      });
    } catch (error) {
      if (isConfigVersionConflict(error)) {
        cleanupNewPolicyFiles(context, managedIdentity, receiptIdentity);
      }
      throw safeConfigWriteError(error);
    }
    options.afterBatchWrite?.();
    receipt.state = "active";
    writePrivateJson(context.receiptPath, receipt);
    return outcome;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}
async function resumeApply(options, context, receipt) {
  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);
    if (!(atBefore || atAfter)) {
      throwConfigDrift(layer.config, receipt, "resume");
    }
    const outcome = {
      receipt,
      action: atAfter ? "activate-recovered" : "resume-apply",
      managedTargetClassification: "owned-managed-copy"
    };
    if (options.dryRun) {
      return outcome;
    }
    if (atBefore) {
      try {
        await rpc.batchWrite({
          edits: receipt.values.map(({ keyPath, after }) => ({
            keyPath,
            value: after,
            mergeStrategy: "replace"
          })),
          filePath: context.configPath,
          expectedVersion: layer.version,
          reloadUserConfig: true
        });
      } catch (error) {
        throw safeConfigWriteError(error);
      }
      options.afterBatchWrite?.();
    }
    receipt.state = "active";
    writePrivateJson(context.receiptPath, receipt);
    return outcome;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}
function restorePromptPolicy(options) {
  return withPromptPolicyLock(canonicalExistingPath(options.codexHome), "restore", options.lockOptions, () => restorePromptPolicyUnlocked(options));
}
async function restorePromptPolicyUnlocked(options) {
  const context = validateContext(options);
  if (!pathEntryExists(context.receiptPath)) {
    throw new Error(`Skizzles prompt-policy receipt is missing: ${context.receiptPath}`);
  }
  const receipt = readAndValidateReceipt(context);
  const managedTargetExists = pathEntryExists(context.managedTarget);
  if (managedTargetExists) {
    validateManagedTarget(context, receipt);
  } else if (receipt.state !== "restoring") {
    throw new Error("prompt-policy managed target is missing; retaining receipt evidence");
  }
  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);
    if (receipt.state === "restoring" && atBefore) {
      const outcome2 = {
        receipt,
        action: "finish-restore",
        managedTargetClassification: "owned-managed-copy"
      };
      if (!options.dryRun) {
        cleanupOwnedPolicyFiles(context, receipt);
      }
      return outcome2;
    }
    if (!managedTargetExists) {
      throw new Error("prompt-policy managed target disappeared before restoration completed; retaining receipt evidence");
    }
    if (receipt.state === "pending" && atBefore) {
      const outcome2 = {
        receipt,
        action: "discard-pending",
        managedTargetClassification: "owned-managed-copy"
      };
      if (!options.dryRun) {
        cleanupOwnedPolicyFiles(context, receipt);
      }
      return outcome2;
    }
    if (!atAfter) {
      throwConfigDrift(layer.config, receipt, "restore");
    }
    const outcome = {
      receipt,
      action: "restore",
      managedTargetClassification: "owned-managed-copy"
    };
    if (options.dryRun) {
      return outcome;
    }
    receipt.state = "restoring";
    writePrivateJson(context.receiptPath, receipt);
    try {
      await rpc.batchWrite({
        edits: restoreConfigEdits(receipt.values),
        filePath: context.configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true
      });
    } catch (error) {
      throw safeConfigWriteError(error);
    }
    options.afterBatchWrite?.();
    cleanupOwnedPolicyFiles(context, receipt);
    return outcome;
  } finally {
    try {
      await rpc.close();
    } finally {
      rpcSession.cleanup();
    }
  }
}
function promptPolicySummary(outcome, dryRun) {
  const { receipt } = outcome;
  return {
    ok: true,
    dryRun,
    surface: "prompt-policy",
    action: outcome.action,
    state: receipt.state,
    configPath: receipt.configPath,
    keys: receipt.values.map(({ keyPath, beforePresent }) => ({
      keyPath,
      beforePresent
    })),
    policy: {
      descriptor: publicFileFact(receipt.policy.descriptor),
      applied: publicFileFact(receipt.policy.applied),
      developerInstructions: publicFileFact(receipt.policy.developerInstructions),
      compactPrompt: publicFileFact(receipt.policy.compactPrompt),
      license: publicLegalFact(receipt.policy.license),
      notice: publicLegalFact(receipt.policy.notice)
    },
    managedTarget: {
      path: receipt.managedTarget.path,
      classification: outcome.managedTargetClassification,
      sha256: receipt.managedTarget.sha256,
      bytes: receipt.managedTarget.bytes
    },
    sessionImpact: "new Codex sessions required",
    compactPromptScope: "local compaction only; remote compaction may bypass it"
  };
}
function validateContext(options) {
  if (!isAbsolute2(options.codexHome)) {
    throw new Error("--codex-home must be an absolute path");
  }
  const codexHome = canonicalExistingPath(options.codexHome);
  if (!(existsSync8(codexHome) && lstatSync7(codexHome).isDirectory())) {
    throw new Error(`CODEX_HOME is missing or not a directory: ${codexHome}`);
  }
  if (lstatSync7(resolve8(options.codexHome)).isSymbolicLink()) {
    throw new Error(`CODEX_HOME may not be a symlink: ${options.codexHome}`);
  }
  assertManagedParentsAreReal(codexHome, [
    ".skizzles",
    `.skizzles/${MANAGED_DIRECTORY}`
  ]);
  const codexBinary = validateCodexBinary(options.codexBinary);
  return {
    codexHome,
    codexBinary,
    configPath: join8(codexHome, "config.toml"),
    receiptPath: join8(codexHome, ".skizzles", RECEIPT_NAME),
    managedDirectory: join8(codexHome, ".skizzles", MANAGED_DIRECTORY),
    managedTarget: join8(codexHome, ".skizzles", MANAGED_DIRECTORY, MANAGED_FILE)
  };
}
function policyEdits(target, source) {
  return [
    { keyPath: POLICY_KEYS[0], value: target, mergeStrategy: "replace" },
    {
      keyPath: POLICY_KEYS[1],
      value: source.developerInstructions,
      mergeStrategy: "replace"
    },
    {
      keyPath: POLICY_KEYS[2],
      value: source.compactPrompt,
      mergeStrategy: "replace"
    }
  ];
}
function readPolicySource(sourceRootInput) {
  if (!isAbsolute2(sourceRootInput)) {
    throw new Error("--source-root must be an absolute path");
  }
  const requestedRoot = resolve8(sourceRootInput);
  if (!existsSync8(requestedRoot)) {
    throw new Error(`prompt-policy source root is missing: ${requestedRoot}`);
  }
  if (lstatSync7(requestedRoot).isSymbolicLink()) {
    throw new Error(`prompt-policy source root may not use symlinked parents: ${requestedRoot}`);
  }
  if (!lstatSync7(requestedRoot).isDirectory()) {
    throw new Error(`prompt-policy source root is not a directory: ${requestedRoot}`);
  }
  const sourceRoot = realpathSync3(requestedRoot);
  const descriptorPath = pathEntryExists(resolve8(sourceRoot, CANONICAL_DESCRIPTOR_PATH)) ? CANONICAL_DESCRIPTOR_PATH : PACKAGED_DESCRIPTOR_PATH;
  const sourcePrefix = descriptorPath === CANONICAL_DESCRIPTOR_PATH ? PROMPT_SOURCE_ROOT : "";
  const descriptorAbsolute = resolveContainedFile(sourceRoot, descriptorPath, "prompt-policy descriptor");
  const descriptorBytes = readFileSync7(descriptorAbsolute);
  validateText(descriptorBytes, "prompt-policy descriptor");
  rejectMachinePaths(descriptorBytes, "prompt-policy descriptor");
  const descriptor = record(readJsonFile(descriptorAbsolute, "prompt-policy descriptor"), "prompt-policy descriptor");
  exactKeys(descriptor, ["schema", "version", "base", "developerInstructions", "compactPrompt"], "prompt-policy descriptor");
  if (descriptor["schema"] !== "skizzles.prompt-policy" || descriptor["version"] !== 1) {
    throw new Error("unsupported prompt-policy descriptor schema or version");
  }
  const base = record(descriptor["base"], "prompt-policy base");
  exactKeys(base, ["role", "applied", "provenance", "upstream", "legal"], "prompt-policy base");
  const role = stringValue(base["role"], "prompt-policy base role");
  const applied = parseFileFact(base["applied"], "base applied prompt");
  const provenance = parseFileFact(base["provenance"], "base provenance");
  const upstream = parseUpstreamFact(base["upstream"]);
  const legal = record(base["legal"], "prompt-policy legal inputs");
  exactKeys(legal, ["license", "notice"], "prompt-policy legal inputs");
  const license = parseLegalFact(legal["license"], "prompt-policy LICENSE");
  const notice = parseLegalFact(legal["notice"], "prompt-policy NOTICE");
  assertCanonicalLegalMappings(license, notice);
  const developerInstructions = parseFileFact(descriptor["developerInstructions"], "developer instructions");
  const compactPrompt = parseFileFact(descriptor["compactPrompt"], "compact prompt");
  const facts = {
    descriptor: {
      path: descriptorPath,
      ...digest(descriptorBytes)
    },
    role,
    applied,
    provenance,
    upstream,
    license,
    notice,
    developerInstructions,
    compactPrompt
  };
  const appliedBytes = readFactFile(sourceRoot, sourcePrefix, applied, "applied base prompt");
  const provenanceBytes = readFactFile(sourceRoot, sourcePrefix, provenance, "base provenance");
  const developerBytes = readFactFile(sourceRoot, sourcePrefix, developerInstructions, "developer instructions");
  const compactBytes = readFactFile(sourceRoot, sourcePrefix, compactPrompt, "compact prompt");
  readLegalFile(sourceRoot, license, "LICENSE");
  readLegalFile(sourceRoot, notice, "NOTICE");
  for (const [bytes, label] of [
    [appliedBytes, "applied base prompt"],
    [provenanceBytes, "base provenance"],
    [developerBytes, "developer instructions"],
    [compactBytes, "compact prompt"]
  ]) {
    validateText(bytes, label);
    rejectMachinePaths(bytes, label);
  }
  validateProvenance(provenanceBytes, facts);
  return {
    facts,
    applied: appliedBytes,
    developerInstructions: developerBytes.toString("utf8"),
    compactPrompt: compactBytes.toString("utf8")
  };
}
function parseFileFact(value, label) {
  const object = record(value, label);
  exactKeys(object, ["path", "sha256", "bytes"], label);
  const path = portableRelativePath(object["path"], `${label} path`);
  return {
    path,
    sha256: sha256Value(object["sha256"], `${label} sha256`),
    bytes: bytesValue(object["bytes"], `${label} bytes`)
  };
}
function parseLegalFact(value, label) {
  const object = record(value, label);
  exactKeys(object, ["sourcePath", "packagedPath", "sha256", "bytes"], label);
  return {
    sourcePath: portableRelativePath(object["sourcePath"], `${label} sourcePath`),
    packagedPath: portableRelativePath(object["packagedPath"], `${label} packagedPath`),
    sha256: sha256Value(object["sha256"], `${label} sha256`),
    bytes: bytesValue(object["bytes"], `${label} bytes`)
  };
}
function assertCanonicalLegalMappings(license, notice) {
  if (license.sourcePath !== "packages/prompt-layer/assets/upstream/LICENSE" || license.packagedPath !== "third_party/openai-codex/LICENSE" || notice.sourcePath !== "packages/prompt-layer/assets/upstream/NOTICE" || notice.packagedPath !== "third_party/openai-codex/NOTICE") {
    throw new Error("prompt-policy legal paths must use the exact canonical LICENSE and NOTICE mappings");
  }
}
function parseUpstreamFact(value) {
  const object = record(value, "prompt-policy upstream");
  exactKeys(object, ["repository", "commit", "path", "sha256", "bytes"], "prompt-policy upstream");
  const repository = stringValue(object["repository"], "upstream repository");
  if (repository !== "https://github.com/openai/codex") {
    throw new Error("prompt-policy upstream repository must be official OpenAI Codex");
  }
  const commit = stringValue(object["commit"], "upstream commit");
  if (!IMMUTABLE_COMMIT_PATTERN.test(commit)) {
    throw new Error("upstream commit must be immutable lowercase SHA-1");
  }
  return {
    repository,
    commit,
    path: portableRelativePath(object["path"], "upstream path"),
    sha256: sha256Value(object["sha256"], "upstream sha256"),
    bytes: bytesValue(object["bytes"], "upstream bytes")
  };
}
function readFactFile(root, sourcePrefix, fact, label) {
  const path = sourcePrefix ? join8(sourcePrefix, fact.path) : fact.path;
  const bytes = readFileSync7(resolveContainedFile(root, path, label));
  assertDigest(bytes, fact, label);
  return bytes;
}
function readLegalFile(root, fact, label) {
  const candidates = [fact.sourcePath, fact.packagedPath].filter((path) => existsSync8(resolve8(root, path)));
  if (candidates.length === 0) {
    throw new Error(`${label} is missing from source and packaged policy paths`);
  }
  let selected;
  for (const path of candidates) {
    const bytes = readFileSync7(resolveContainedFile(root, path, label));
    assertDigest(bytes, fact, label);
    selected ??= bytes;
  }
  if (!selected) {
    throw new Error(`${label} has no readable policy input`);
  }
  return selected;
}
function validateProvenance(bytes, facts) {
  const provenance = record(JSON.parse(bytes.toString("utf8")), "base provenance");
  if (provenance["schema"] !== "skizzles.prompt-layer" || provenance["version"] !== 1 || provenance["baselineRole"] !== facts.role) {
    throw new Error("base provenance schema, version, or role does not match prompt-policy descriptor");
  }
  const upstream = record(provenance["upstream"], "base provenance upstream");
  for (const key of [
    "repository",
    "commit",
    "path",
    "sha256",
    "bytes"
  ]) {
    if (upstream[key] !== facts.upstream[key]) {
      throw new Error(`base provenance upstream ${key} does not match prompt-policy descriptor`);
    }
  }
  const output = record(provenance["output"], "base provenance output");
  if (output["sha256"] !== facts.applied.sha256 || output["bytes"] !== facts.applied.bytes) {
    throw new Error("base provenance output does not match applied prompt descriptor");
  }
  const legal = record(provenance["legal"], "base provenance legal");
  for (const [name, fact] of [
    ["license", facts.license],
    ["notice", facts.notice]
  ]) {
    const item = record(legal[name], `base provenance ${name}`);
    if (item["sha256"] !== fact.sha256 || item["bytes"] !== fact.bytes) {
      throw new Error(`base provenance ${name} does not match prompt-policy descriptor`);
    }
  }
}
function createManagedTarget(context, bytes) {
  const skizzlesDirectory = dirname5(context.managedDirectory);
  mkdirSync6(skizzlesDirectory, { recursive: true, mode: 448 });
  chmodSync4(skizzlesDirectory, 448);
  let createdDirectory = false;
  let createdTarget;
  try {
    mkdirSync6(context.managedDirectory, { mode: 448 });
    createdDirectory = true;
    chmodSync4(context.managedDirectory, 448);
    writeFileSync5(context.managedTarget, bytes, { flag: "wx", mode: 384 });
    createdTarget = fileIdentity2(context.managedTarget);
    chmodSync4(context.managedTarget, 384);
    return createdTarget;
  } catch (error) {
    if (createdTarget) {
      removeOwnedIdentity(context.managedTarget, createdTarget);
    }
    if (createdDirectory) {
      removeDirectoryIfEmpty(context.managedDirectory);
    }
    throw error;
  }
}
function readAndValidateReceipt(context) {
  assertPrivateDirectory(dirname5(context.receiptPath), ".skizzles directory");
  if (pathEntryExists(context.managedDirectory)) {
    assertPrivateDirectory(context.managedDirectory, "prompt-policy managed directory");
  }
  assertRegularPrivateFile(context.receiptPath, "prompt-policy receipt");
  const value = record(readJsonFile(context.receiptPath, "Skizzles prompt-policy receipt"), "prompt-policy receipt");
  exactKeys(value, [
    "schema",
    "version",
    "state",
    "codexBinary",
    "configPath",
    "managedTarget",
    "policy",
    "values"
  ], "prompt-policy receipt");
  if (value["schema"] !== "skizzles.prompt-policy-receipt" || value["version"] !== 1) {
    throw new Error("invalid prompt-policy receipt schema, version, or state");
  }
  const state = receiptState(value["state"]);
  const codexBinary = stringValue(value["codexBinary"], "receipt Codex binary");
  if (!isAbsolute2(codexBinary) || resolve8(codexBinary) !== context.codexBinary) {
    throw new Error(`use the Codex binary recorded by the prompt-policy receipt: ${codexBinary}`);
  }
  const configPath = stringValue(value["configPath"], "receipt config path");
  if (!isAbsolute2(configPath) || resolve8(configPath) !== context.configPath) {
    throw new Error("prompt-policy receipt config path is outside selected CODEX_HOME");
  }
  const targetObject = record(value["managedTarget"], "receipt managed target");
  exactKeys(targetObject, ["path", "sha256", "bytes"], "receipt managed target");
  const target = {
    path: stringValue(targetObject["path"], "receipt managed target path"),
    sha256: sha256Value(targetObject["sha256"], "receipt managed target sha256"),
    bytes: bytesValue(targetObject["bytes"], "receipt managed target bytes")
  };
  if (!isAbsolute2(target.path) || resolve8(target.path) !== context.managedTarget) {
    throw new Error("prompt-policy receipt managed target is escaped or swapped");
  }
  const policy = validateReceiptPolicy(value["policy"]);
  const values = parseReceiptValues(value["values"], target, policy);
  const receipt = {
    schema: "skizzles.prompt-policy-receipt",
    version: 1,
    state,
    codexBinary,
    configPath,
    managedTarget: target,
    policy,
    values
  };
  return receipt;
}
function receiptState(value) {
  if (value === "pending" || value === "active" || value === "restoring") {
    return value;
  }
  throw new Error("invalid prompt-policy receipt schema, version, or state");
}
function validateReceiptPolicy(value) {
  const object = record(value, "receipt policy facts");
  exactKeys(object, [
    "descriptor",
    "role",
    "applied",
    "provenance",
    "upstream",
    "license",
    "notice",
    "developerInstructions",
    "compactPrompt"
  ], "receipt policy facts");
  const policy = {
    descriptor: parseFileFact(object["descriptor"], "receipt descriptor"),
    role: stringValue(object["role"], "receipt policy role"),
    applied: parseFileFact(object["applied"], "receipt applied prompt"),
    provenance: parseFileFact(object["provenance"], "receipt provenance"),
    upstream: parseUpstreamFact(object["upstream"]),
    license: parseLegalFact(object["license"], "receipt LICENSE"),
    notice: parseLegalFact(object["notice"], "receipt NOTICE"),
    developerInstructions: parseFileFact(object["developerInstructions"], "receipt developer instructions"),
    compactPrompt: parseFileFact(object["compactPrompt"], "receipt compact prompt")
  };
  assertCanonicalLegalMappings(policy.license, policy.notice);
  return policy;
}
function parseReceiptValues(value, managedTarget, policy) {
  if (!Array.isArray(value) || value.length !== POLICY_KEYS.length) {
    throw new Error("prompt-policy receipt must own exactly three config values");
  }
  const values = [];
  for (const [index, expectedKey] of POLICY_KEYS.entries()) {
    const owned = record(value[index], `receipt value ${expectedKey}`);
    exactKeys(owned, ["keyPath", "beforePresent", "before", "after"], `receipt value ${expectedKey}`);
    if (owned["keyPath"] !== expectedKey || typeof owned["beforePresent"] !== "boolean") {
      throw new Error(`prompt-policy receipt has invalid owned key ${expectedKey}`);
    }
    values.push({
      keyPath: expectedKey,
      beforePresent: owned["beforePresent"],
      before: jsonValue(owned["before"], `receipt ${expectedKey} before`),
      after: jsonValue(owned["after"], `receipt ${expectedKey} after`)
    });
  }
  const modelInstructionsAfter = values[0]?.after;
  if (typeof modelInstructionsAfter !== "string") {
    throw new Error("receipt model instructions target must be a string");
  }
  if (modelInstructionsAfter !== managedTarget.path) {
    throw new Error("prompt-policy receipt model instructions target is swapped");
  }
  for (const [index, fact, label] of [
    [1, policy.developerInstructions, "developer instructions"],
    [2, policy.compactPrompt, "compact prompt"]
  ]) {
    const after = values[index]?.after;
    if (typeof after !== "string") {
      throw new Error(`receipt ${label} is not a string`);
    }
    assertDigest(Buffer.from(after), fact, `receipt ${label}`);
  }
  if (managedTarget.sha256 !== policy.applied.sha256 || managedTarget.bytes !== policy.applied.bytes) {
    throw new Error("receipt managed target fact does not match applied prompt fact");
  }
  return values;
}
function validateManagedTarget(context, receipt) {
  assertPrivateDirectory(dirname5(context.managedDirectory), ".skizzles directory");
  assertPrivateDirectory(context.managedDirectory, "prompt-policy managed directory");
  assertRegularPrivateFile(context.managedTarget, "prompt-policy managed target");
  const bytes = readFileSync7(context.managedTarget);
  assertDigest(bytes, receipt.managedTarget, "prompt-policy managed target");
}
function validateSourceMatchesReceipt(source, receipt) {
  if (JSON.stringify(source.facts) !== JSON.stringify(receipt.policy)) {
    throw new Error("selected prompt-policy source does not match the pending receipt");
  }
}
function cleanupNewPolicyFiles(context, managedIdentity, receiptIdentity) {
  const receiptPresent = receiptIdentity ? assertOwnedIdentity(context.receiptPath, receiptIdentity) : false;
  const managedPresent = assertOwnedIdentity(context.managedTarget, managedIdentity);
  if (receiptPresent) {
    rmSync8(context.receiptPath);
  }
  if (managedPresent) {
    rmSync8(context.managedTarget);
  }
  removeDirectoryIfEmpty(context.managedDirectory);
}
function cleanupOwnedPolicyFiles(context, receipt) {
  if (pathEntryExists(context.managedTarget)) {
    validateManagedTarget(context, receipt);
    rmSync8(context.managedTarget);
  }
  removeDirectoryIfEmpty(context.managedDirectory);
  rmSync8(context.receiptPath, { force: true });
}
function removeDirectoryIfEmpty(path) {
  if (existsSync8(path) && readdirSync4(path).length === 0) {
    rmdirSync2(path);
  }
}
function fileIdentity2(path) {
  const metadata = lstatSync7(path);
  return { dev: metadata.dev, ino: metadata.ino };
}
function removeOwnedIdentity(path, expected) {
  if (!assertOwnedIdentity(path, expected)) {
    return;
  }
  rmSync8(path);
}
function assertOwnedIdentity(path, expected) {
  if (!pathEntryExists(path)) {
    return false;
  }
  const actual = fileIdentity2(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`refusing to clean replaced prompt-policy owned file: ${path}`);
  }
  return true;
}
function throwConfigDrift(config, receipt, operation) {
  const drifted = receipt.values.filter((value) => {
    const current = configValue(config, value.keyPath);
    const before = current.present === value.beforePresent && (!value.beforePresent || sameJson(current.value, value.before));
    const after = current.present && sameJson(current.value, value.after);
    return !(before || after);
  }).map(({ keyPath }) => keyPath);
  const keys = drifted.length > 0 ? drifted : POLICY_KEYS;
  throw new Error(`refusing to ${operation} drifted prompt-policy config keys: ${keys.join(", ")}`);
}
function configValue(root, keyPath) {
  let current = root;
  for (const segment of keyPath.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object" || !(segment in current)) {
      return { present: false, value: null };
    }
    const next = current[segment];
    if (next === undefined) {
      return { present: false, value: null };
    }
    current = next;
  }
  return { present: true, value: current };
}
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function resolveContainedFile(root, path, label) {
  const portable = portableRelativePath(path, `${label} path`);
  const absolute = resolve8(root, portable);
  const containment = relative3(root, absolute);
  if (containment.startsWith("..") || isAbsolute2(containment)) {
    throw new Error(`${label} escapes prompt-policy source root`);
  }
  let current = root;
  for (const segment of portable.split("/")) {
    current = join8(current, segment);
    if (!pathEntryExists(current)) {
      throw new Error(`${label} is missing: ${portable}`);
    }
    const metadata = lstatSync7(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} uses a symlink: ${portable}`);
    }
  }
  if (!lstatSync7(absolute).isFile() || realpathSync3(absolute) !== absolute) {
    throw new Error(`${label} must be a contained regular file: ${portable}`);
  }
  return absolute;
}
function portableRelativePath(value, label) {
  const path = stringValue(value, label);
  if (path.length === 0 || isAbsolute2(path) || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a normalized portable relative path`);
  }
  return path;
}
function assertDigest(bytes, fact, label) {
  const actual = digest(bytes);
  if (actual.sha256 !== fact.sha256 || actual.bytes !== fact.bytes) {
    throw new Error(`${label} digest or byte count does not match prompt-policy descriptor`);
  }
}
function digest(bytes) {
  return {
    sha256: createHash2("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength
  };
}
function validateText(bytes, label) {
  if (bytes.length === 0 || bytes.includes(0) || bytes.at(-1) !== 10 || bytes.includes(Buffer.from("\r"))) {
    throw new Error(`${label} must be non-empty LF text with a final newline and no NUL`);
  }
}
function rejectMachinePaths(bytes, label) {
  const text = bytes.toString("utf8");
  const match = MACHINE_PATH_PATTERNS.find((pattern) => pattern.test(text));
  if (match) {
    throw new Error(`${label} contains a machine-specific path`);
  }
}
function assertRegularPrivateFile(path, label) {
  if (!pathEntryExists(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
  const metadata = lstatSync7(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if ((metadata.mode & 511) !== 384) {
    throw new Error(`${label} must have owner-only mode 0600`);
  }
}
function assertPrivateDirectory(path, label) {
  if (!pathEntryExists(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
  const metadata = lstatSync7(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if ((metadata.mode & 511) !== 448) {
    throw new Error(`${label} must have owner-only mode 0700`);
  }
}
function exactKeys(object, expected, label) {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.join("\x00") !== wanted.join("\x00")) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}
function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}
function jsonValue(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = jsonValue(item, `${label}.${key}`);
    }
    return result;
  }
  throw new Error(`${label} must be a JSON value`);
}
function stringValue(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
function sha256Value(value, label) {
  const text = stringValue(value, label);
  if (!SHA256_PATTERN.test(text)) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
  return text;
}
function bytesValue(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
function publicFileFact(fact) {
  return { sha256: fact.sha256, bytes: fact.bytes };
}
function publicLegalFact(fact) {
  return { sha256: fact.sha256, bytes: fact.bytes };
}

// packages/installer/src/cli.ts
var FLAG_NAMES = {
  "--codex-home": "codexHome",
  "--codex-binary": "codexBinary",
  "--orchestration": "orchestration",
  "--home": "home",
  "--source-root": "sourceRoot",
  "--transfer": "transfer",
  "--mode": "transfer",
  "--surface": "surface",
  "--dry-run": "dryRun"
};
function usage() {
  console.error("usage: skizzles-installer install --surface <skills|harness> [--codex-home PATH|--home PATH] [--source-root PATH] [--transfer link|copy] [--dry-run] | uninstall --surface <skills|harness> [--codex-home PATH|--home PATH] [--dry-run] | configure --codex-home PATH --codex-binary PATH --orchestration <aggressive|passive> [--dry-run] | unconfigure --codex-home PATH --codex-binary PATH [--dry-run] | prompt-policy apply --codex-home PATH --codex-binary ABSOLUTE_PATH --source-root PATH [--dry-run] | prompt-policy restore --codex-home PATH --codex-binary ABSOLUTE_PATH [--dry-run] | doctor --home PATH --codex-home PATH");
  process4.exit(2);
}
function parse(argv) {
  const command = argv.shift();
  switch (command) {
    case "install":
      return parseInstall(argv);
    case "uninstall":
      return parseUninstall(argv);
    case "doctor":
      return parseDoctor(argv);
    case "configure":
      return parseConfigure(argv);
    case "unconfigure":
      return parseUnconfigure(argv);
    case "prompt-policy":
      return parsePromptPolicy(argv);
    default:
      return usage();
  }
}
function parseInstall(argv) {
  const flags = parseFlags(argv, allowed("surface", "codexHome", "home", "sourceRoot", "transfer", "dryRun"));
  const surface = parseSurface(required(flags.surface));
  const sourceRoot = resolve9(flags.sourceRoot ?? defaultSourceRoot());
  const transfer = parseTransfer(flags.transfer ?? "link");
  if (surface === "skills") {
    if (flags.home !== undefined) {
      usage();
    }
    return {
      command: "install",
      surface,
      codexHome: resolve9(required(flags.codexHome)),
      sourceRoot,
      transfer,
      dryRun: flags.dryRun
    };
  }
  if (flags.codexHome !== undefined) {
    usage();
  }
  return {
    command: "install",
    surface,
    home: resolve9(required(flags.home)),
    sourceRoot,
    transfer,
    dryRun: flags.dryRun
  };
}
function parseUninstall(argv) {
  const flags = parseFlags(argv, allowed("surface", "codexHome", "home", "dryRun"));
  const surface = parseSurface(required(flags.surface));
  if (surface === "skills") {
    if (flags.home !== undefined) {
      usage();
    }
    return {
      command: "uninstall",
      surface,
      codexHome: resolve9(required(flags.codexHome)),
      dryRun: flags.dryRun
    };
  }
  if (flags.codexHome !== undefined) {
    usage();
  }
  return {
    command: "uninstall",
    surface,
    home: resolve9(required(flags.home)),
    dryRun: flags.dryRun
  };
}
function parseDoctor(argv) {
  const flags = parseFlags(argv, allowed("home", "codexHome"));
  return {
    command: "doctor",
    home: resolve9(required(flags.home)),
    codexHome: resolve9(required(flags.codexHome))
  };
}
function parseConfigure(argv) {
  const flags = parseFlags(argv, allowed("codexHome", "codexBinary", "orchestration", "dryRun"));
  return {
    command: "configure",
    codexHome: resolve9(required(flags.codexHome)),
    codexBinary: required(flags.codexBinary),
    orchestration: parseOrchestration(required(flags.orchestration)),
    dryRun: flags.dryRun
  };
}
function parseUnconfigure(argv) {
  const flags = parseFlags(argv, allowed("codexHome", "codexBinary", "dryRun"));
  return {
    command: "unconfigure",
    codexHome: resolve9(required(flags.codexHome)),
    codexBinary: required(flags.codexBinary),
    dryRun: flags.dryRun
  };
}
function parsePromptPolicy(argv) {
  const action = argv.shift();
  if (action === "apply") {
    const flags = parseFlags(argv, allowed("codexHome", "codexBinary", "sourceRoot", "dryRun"));
    return {
      command: "prompt-policy",
      action,
      codexHome: resolve9(required(flags.codexHome)),
      codexBinary: absoluteBinary(required(flags.codexBinary)),
      sourceRoot: resolve9(required(flags.sourceRoot)),
      dryRun: flags.dryRun
    };
  }
  if (action === "restore") {
    const flags = parseFlags(argv, allowed("codexHome", "codexBinary", "dryRun"));
    return {
      command: "prompt-policy",
      action,
      codexHome: resolve9(required(flags.codexHome)),
      codexBinary: absoluteBinary(required(flags.codexBinary)),
      dryRun: flags.dryRun
    };
  }
  return usage();
}
function parseFlags(argv, allowedFlags) {
  const parsed = { dryRun: false };
  const seen = new Set;
  while (argv.length > 0) {
    const spelling = argv.shift();
    const flag = spelling === undefined ? undefined : FLAG_NAMES[spelling];
    if (flag === undefined || !allowedFlags.has(flag) || seen.has(flag)) {
      usage();
    }
    seen.add(flag);
    if (flag === "dryRun") {
      parsed.dryRun = true;
      continue;
    }
    parsed[flag] = required(argv.shift());
  }
  return parsed;
}
function allowed(...flags) {
  return new Set(flags);
}
function required(value) {
  return value ?? usage();
}
function parseSurface(value) {
  if (value === "skills" || value === "harness") {
    return value;
  }
  return usage();
}
function parseTransfer(value) {
  if (value === "link" || value === "copy") {
    return value;
  }
  return usage();
}
function parseOrchestration(value) {
  if (value === "aggressive" || value === "passive") {
    return value;
  }
  return usage();
}
function absoluteBinary(value) {
  if (!isAbsolute3(value)) {
    usage();
  }
  return value;
}
function defaultSourceRoot() {
  return resolve9(import.meta.dir, "../../..");
}
async function main(argv = process4.argv.slice(2)) {
  const parsed = parse([...argv]);
  switch (parsed.command) {
    case "doctor": {
      const report = doctor(parsed.home, parsed.codexHome);
      console.log(JSON.stringify(report));
      if (!report.ok) {
        process4.exitCode = 1;
      }
      return;
    }
    case "configure": {
      const receipt = await configureCodex(parsed);
      printConfigSummary(receipt, parsed.dryRun);
      return;
    }
    case "unconfigure": {
      const receipt = await unconfigureCodex(parsed);
      printConfigSummary(receipt, parsed.dryRun);
      return;
    }
    case "prompt-policy": {
      const outcome = parsed.action === "apply" ? await applyPromptPolicy(parsed) : await restorePromptPolicy(parsed);
      console.log(JSON.stringify(promptPolicySummary(outcome, parsed.dryRun)));
      return;
    }
    case "install": {
      if (parsed.surface === "skills") {
        const receipt2 = installSkills(parsed);
        console.log(JSON.stringify({
          ok: true,
          dryRun: parsed.dryRun,
          ...receiptSummary(receipt2)
        }));
        return;
      }
      const receipt = installHarness(parsed);
      printHarnessSummary(receipt, parsed.dryRun);
      return;
    }
    case "uninstall": {
      if (parsed.surface === "skills") {
        const receipt2 = uninstallSkills(parsed.codexHome, parsed.dryRun);
        console.log(JSON.stringify({
          ok: true,
          dryRun: parsed.dryRun,
          ...receiptSummary(receipt2)
        }));
        return;
      }
      const receipt = uninstallHarness(parsed.home, parsed.dryRun);
      printHarnessSummary(receipt, parsed.dryRun);
      return;
    }
    default:
      return assertNever(parsed);
  }
}
function printConfigSummary(receipt, dryRun) {
  console.log(JSON.stringify({
    ok: true,
    dryRun,
    surface: "config",
    orchestration: receipt.orchestration,
    configPath: receipt.configPath,
    keys: receipt.values.map(({ keyPath }) => keyPath)
  }));
}
function printHarnessSummary(receipt, dryRun) {
  console.log(JSON.stringify({
    ok: true,
    dryRun,
    surface: "harness",
    transfer: receipt.transfer,
    pluginTarget: receipt.pluginTarget
  }));
}
function assertNever(value) {
  throw new Error(`unreachable installer command: ${JSON.stringify(value)}`);
}
if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "installer failed");
    process4.exit(1);
  });
}
export {
  main
};
