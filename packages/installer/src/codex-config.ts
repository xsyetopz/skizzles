import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathEntryExists } from "./managed-files.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ConfigEdit {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: "replace";
}

export interface ConfigLayer {
  name: { type: string; file?: string; profile?: string | null };
  version: string;
  config: JsonValue;
}

export interface ConfigReadResponse {
  config?: JsonValue;
  layers: ConfigLayer[] | null;
}

export interface ConfigWriteResponse {
  status: string;
  version: string;
  filePath: string;
}

export interface ConfigRpc {
  read(): Promise<ConfigReadResponse>;
  batchWrite(params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }): Promise<ConfigWriteResponse>;
  close(): Promise<void>;
}

export interface ConfigRpcSession {
  rpc: ConfigRpc;
  configPath: string;
  cleanup(): void;
}

export async function openConfigRpcSession(options: {
  codexHome: string;
  codexBinary: string;
  dryRun?: boolean | undefined;
  rpcFactory?:
    | ((codexHome: string, codexBinary: string) => Promise<ConfigRpc>)
    | undefined;
}): Promise<ConfigRpcSession> {
  const selectedHome = canonicalExistingPath(options.codexHome);
  const configPath = join(selectedHome, "config.toml");
  if (!options.dryRun || options.rpcFactory) {
    return {
      rpc: await (options.rpcFactory ?? AppServerRpc.create)(
        selectedHome,
        options.codexBinary,
      ),
      configPath,
      cleanup: noRpcCleanup,
    };
  }
  const previewHome = realpathSync(
    mkdtempSync(join(tmpdir(), "skizzles-config-preview-")),
  );
  chmodSync(previewHome, 0o700);
  try {
    createConfigPreviewSnapshot(selectedHome, previewHome);
    const inner = await AppServerRpc.create(previewHome, options.codexBinary);
    return {
      rpc: new PreviewConfigRpc(inner, previewHome, selectedHome),
      configPath,
      cleanup: () => rmSync(previewHome, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(previewHome, { recursive: true, force: true });
    throw error;
  }
}

const PREVIEW_PROMPT_FILE_KEYS = [
  "model_instructions_file",
  "experimental_compact_prompt_file",
  "model_catalog_json",
] as const;
const PREVIEW_NESTED_TOML_KEYS = new Set(["config_file"]);
const MAX_PREVIEW_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_REFERENCED_FILES = 256;
const MAX_PREVIEW_NESTED_CONFIG_DEPTH = 16;

interface PreviewBudget {
  bytes: number;
  copied: Set<string>;
  referencedFiles: number;
}

interface SnapshotIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

type SnapshotStat = {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
};

function snapshotStat(stat: SnapshotStat): SnapshotIdentity {
  const mtimeNs = statNanoseconds(stat.mtimeNs, stat.mtimeMs);
  const ctimeNs = statNanoseconds(stat.ctimeNs, stat.ctimeMs);
  return {
    path: "",
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs,
    ctimeNs,
  };
}

function statNanoseconds(
  nanoseconds: bigint | undefined,
  milliseconds: number | bigint,
): bigint {
  if (nanoseconds !== undefined) {
    return nanoseconds;
  }
  return typeof milliseconds === "bigint"
    ? milliseconds * 1_000_000n
    : BigInt(Math.round(milliseconds * 1_000_000));
}

function createConfigPreviewSnapshot(
  selectedHome: string,
  previewHome: string,
): void {
  const configPath = join(selectedHome, "config.toml");
  if (!pathEntryExists(configPath)) {
    return;
  }
  const configBytes = copyPrivateSnapshotFile(
    selectedHome,
    configPath,
    join(previewHome, "config.toml"),
    "selected Codex config",
    MAX_PREVIEW_TOTAL_BYTES,
  );
  const budget: PreviewBudget = {
    bytes: configBytes,
    copied: new Set([canonicalExistingPath(configPath)]),
    referencedFiles: 0,
  };
  copyRelativeConfigInputs(configPath, selectedHome, previewHome, budget, 0);
}

function copyRelativeConfigInputs(
  documentPath: string,
  selectedHome: string,
  previewHome: string,
  budget: PreviewBudget,
  depth: number,
): void {
  const contents = readFileSync(
    join(previewHome, safeSnapshotRelativePath(selectedHome, documentPath)),
    "utf8",
  );
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(contents);
  } catch {
    // Codex owns malformed-config diagnostics and fallback behavior. A malformed
    // document cannot contain a dependable relative-reference contract.
    return;
  }
  for (const reference of configFileReferences(parsed)) {
    if (isAbsolute(reference.value) || isHomeRelative(reference.value)) {
      continue;
    }
    const source = resolve(dirname(documentPath), reference.value);
    const relativePath = safeSnapshotRelativePath(selectedHome, source);
    const sourceKey = canonicalExistingPath(source);
    if (budget.copied.has(sourceKey)) {
      continue;
    }
    if (budget.referencedFiles >= MAX_PREVIEW_REFERENCED_FILES) {
      throw new Error("dry-run snapshot referenced-file limit exceeded");
    }
    if (
      PREVIEW_NESTED_TOML_KEYS.has(reference.key) &&
      depth >= MAX_PREVIEW_NESTED_CONFIG_DEPTH
    ) {
      throw new Error("dry-run snapshot nested-config depth limit exceeded");
    }
    budget.referencedFiles += 1;
    const destination = join(previewHome, relativePath);
    const copiedBytes = copyPrivateSnapshotFile(
      selectedHome,
      source,
      destination,
      reference.key,
      Math.min(MAX_PREVIEW_FILE_BYTES, MAX_PREVIEW_TOTAL_BYTES - budget.bytes),
    );
    budget.bytes += copiedBytes;
    budget.copied.add(sourceKey);
    if (PREVIEW_NESTED_TOML_KEYS.has(reference.key)) {
      copyRelativeConfigInputs(
        source,
        selectedHome,
        previewHome,
        budget,
        depth + 1,
      );
    }
  }
}

function configFileReferences(
  value: unknown,
): { key: string; value: string }[] {
  const references: { key: string; value: string }[] = [];
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

function addPromptFileReferences(
  config: Record<string, unknown>,
  references: { key: string; value: string }[],
): void {
  for (const key of PREVIEW_PROMPT_FILE_KEYS) {
    const value = config[key];
    if (typeof value === "string") {
      references.push({ key, value });
    }
  }
}

function snapshotSourceIdentities(
  selectedHome: string,
  source: string,
  label: string,
): SnapshotIdentity[] {
  const relativePath = safeSnapshotRelativePath(selectedHome, source);
  const identities: SnapshotIdentity[] = [];
  let current = selectedHome;
  for (const segment of ["", ...relativePath.split(sep)]) {
    if (segment) {
      current = join(current, segment);
    }
    let metadata: SnapshotStat;
    try {
      metadata = lstatSync(current, { bigint: true });
    } catch {
      throw new Error(`${label} is missing from the selected Codex home`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} may not traverse a symlink`);
    }
    const identity = snapshotStat(metadata);
    identities.push({ ...identity, path: current });
  }
  if (!lstatSync(source, { bigint: true }).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return identities;
}

function safeSnapshotRelativePath(
  selectedHome: string,
  source: string,
): string {
  const relativePath = relative(selectedHome, source);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      "selected Codex config-relative input escapes the selected home",
    );
  }
  return relativePath;
}

function copyPrivateSnapshotFile(
  selectedHome: string,
  source: string,
  destination: string,
  label: string,
  maxBytes: number,
): number {
  const identities = snapshotSourceIdentities(selectedHome, source, label);
  const expectedFile = identities.at(-1);
  if (!expectedFile) {
    throw new Error("config snapshot identity is empty");
  }
  const descriptor = openSync(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertSnapshotStat(opened, expectedFile, label);
    if (opened.size > BigInt(maxBytes)) {
      throw new Error(
        "selected Codex config-relative input exceeds the dry-run snapshot limit",
      );
    }
    assertSnapshotIdentities(identities, label);
    bytes = readFileSync(descriptor);
    // A second independent descriptor catches in-place rewrites that preserve
    // identity, size, and timestamps (where the platform permits that).
    const rereadDescriptor = openSync(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const rereadStat = fstatSync(rereadDescriptor, { bigint: true });
      assertSnapshotStat(rereadStat, expectedFile, label);
      const reread = readFileSync(rereadDescriptor);
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
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  chmodSync(dirname(destination), 0o700);
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(destination, 0o600);
  return bytes.byteLength;
}

function metadataNanoseconds(
  stat: SnapshotStat,
  field: "mtime" | "ctime",
): bigint {
  const ns = field === "mtime" ? stat.mtimeNs : stat.ctimeNs;
  const ms = field === "mtime" ? stat.mtimeMs : stat.ctimeMs;
  return statNanoseconds(ns, ms);
}

function assertSnapshotStat(
  actual: SnapshotStat,
  expected: SnapshotIdentity,
  label: string,
): void {
  if (
    !actual.isFile() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    metadataNanoseconds(actual, "mtime") !== expected.mtimeNs ||
    metadataNanoseconds(actual, "ctime") !== expected.ctimeNs
  ) {
    throw new Error(`${label} changed during dry-run snapshot`);
  }
}

function assertSnapshotIdentities(
  identities: SnapshotIdentity[],
  label: string,
): void {
  for (const expected of identities) {
    let actual: SnapshotStat;
    try {
      actual = lstatSync(expected.path, { bigint: true });
    } catch {
      throw new Error(`${label} changed during dry-run snapshot`);
    }
    if (
      actual.isSymbolicLink() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.size !== expected.size ||
      metadataNanoseconds(actual, "mtime") !== expected.mtimeNs ||
      metadataNanoseconds(actual, "ctime") !== expected.ctimeNs
    ) {
      throw new Error(`${label} changed during dry-run snapshot`);
    }
  }
}

function isHomeRelative(path: string): boolean {
  return path === "~" || path.startsWith(`~${sep}`) || path.startsWith("~/");
}

class PreviewConfigRpc implements ConfigRpc {
  private readonly inner: ConfigRpc;
  private readonly previewHome: string;
  private readonly selectedHome: string;

  constructor(inner: ConfigRpc, previewHome: string, selectedHome: string) {
    this.inner = inner;
    this.previewHome = previewHome;
    this.selectedHome = selectedHome;
  }

  async read(): Promise<ConfigReadResponse> {
    const read = await this.inner.read();
    return parseConfigReadResponse(
      remapPreviewValue(read, this.previewHome, this.selectedHome),
    );
  }

  batchWrite(_params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }): Promise<ConfigWriteResponse> {
    return Promise.reject(
      new ConfigRpcError(
        "transport",
        "dry-run preview may not write Codex configuration",
      ),
    );
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

function remapPreviewValue(
  value: unknown,
  previewHome: string,
  selectedHome: string,
): unknown {
  if (typeof value === "string") {
    if (value === previewHome) {
      return selectedHome;
    }
    if (value.startsWith(`${previewHome}${sep}`)) {
      return join(selectedHome, relative(previewHome, value));
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      remapPreviewValue(item, previewHome, selectedHome),
    );
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      remapPreviewValue(child, previewHome, selectedHome),
    ]),
  );
}

function noRpcCleanup(): void {
  // A non-preview RPC has no disposable home.
}

export type ConfigRpcErrorKind = "conflict" | "protocol" | "transport";
// Exact camelCase wire values of Codex app-server's ConfigWriteErrorCode enum.
const CONFIG_WRITE_ERROR_CODES = new Set([
  "configLayerReadonly",
  "configVersionConflict",
  "configValidationError",
  "configPathNotFound",
  "configSchemaUnknownKey",
  "userLayerNotFound",
]);
const SAFE_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/;

export class ConfigRpcError extends Error {
  readonly kind: ConfigRpcErrorKind;
  readonly code: string | undefined;

  constructor(kind: ConfigRpcErrorKind, message: string, code?: string) {
    super(message);
    this.name = "ConfigRpcError";
    this.kind = kind;
    this.code = code;
  }
}

export function isConfigVersionConflict(error: unknown): boolean {
  return error instanceof ConfigRpcError && error.kind === "conflict";
}

export function safeConfigWriteError(error: unknown): Error {
  if (isConfigVersionConflict(error)) {
    return new ConfigRpcError(
      "conflict",
      "Codex config version conflict; no config write was committed",
      "configVersionConflict",
    );
  }
  if (error instanceof ConfigRpcError) {
    return error;
  }
  return new ConfigRpcError(
    "transport",
    "Codex config write outcome is ambiguous; pending recovery evidence was retained",
  );
}

export interface OwnedConfigValue {
  keyPath: string;
  beforePresent: boolean;
  before: JsonValue;
  after: JsonValue;
}

export function canonicalExistingPath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export function validateCodexBinary(codexBinary: string): string {
  if (!isAbsolute(codexBinary)) {
    throw new Error("--codex-binary must be an absolute path");
  }
  const binary = resolve(codexBinary);
  if (!existsSync(binary)) {
    throw new Error(`Codex binary is missing: ${binary}`);
  }
  const metadata = lstatSync(binary);
  if (!(metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error(`Codex binary is not a file: ${binary}`);
  }
  return binary;
}

export function configValueAt(
  root: JsonValue,
  keyPath: string,
): { present: boolean; value: JsonValue } {
  let current = root;
  for (const segment of keyPath.split(".")) {
    if (
      current === null ||
      Array.isArray(current) ||
      typeof current !== "object" ||
      !(segment in current)
    ) {
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

export function sameConfigValue(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function selectedUserLayer(
  read: ConfigReadResponse,
  configPath: string,
): ConfigLayer {
  const expected = canonicalExistingPath(configPath);
  const layer = read.layers?.find(
    ({ name }) =>
      name.type === "user" &&
      name.profile === null &&
      name.file !== undefined &&
      canonicalExistingPath(name.file) === expected,
  );
  if (!layer) {
    throw new Error(
      `Codex did not report the selected user config layer: ${expected}`,
    );
  }
  return layer;
}

export function snapshotConfigValues(
  config: JsonValue,
  edits: ConfigEdit[],
): OwnedConfigValue[] {
  return edits.map(({ keyPath, value }) => {
    const before = configValueAt(config, keyPath);
    return {
      keyPath,
      beforePresent: before.present,
      before: before.value,
      after: value,
    };
  });
}

export function valuesMatchBefore(
  config: JsonValue,
  values: OwnedConfigValue[],
): boolean {
  return values.every(({ keyPath, beforePresent, before }) => {
    const current = configValueAt(config, keyPath);
    return (
      current.present === beforePresent &&
      (!beforePresent || sameConfigValue(current.value, before))
    );
  });
}

export function valuesMatchAfter(
  config: JsonValue,
  values: OwnedConfigValue[],
): boolean {
  return values.every(({ keyPath, after }) => {
    const current = configValueAt(config, keyPath);
    return current.present && sameConfigValue(current.value, after);
  });
}

export function restoreConfigEdits(values: OwnedConfigValue[]): ConfigEdit[] {
  return values.map(({ keyPath, beforePresent, before }) => ({
    keyPath,
    value: beforePresent ? before : null,
    mergeStrategy: "replace",
  }));
}

export function ensurePrivateDirectory(path: string): void {
  if (pathEntryExists(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(
      `refusing to manage through a symlinked directory: ${path}`,
    );
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function writePrivateJson(
  path: string,
  value: unknown,
  exclusive = false,
): void {
  ensurePrivateDirectory(dirname(path));
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) {
    writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`invalid ${label}: ${path}`);
  }
}

export class AppServerRpc implements ConfigRpc {
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  private constructor(process: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    this.process = process;
  }

  static async create(
    codexHome: string,
    codexBinary: string,
  ): Promise<AppServerRpc> {
    const process = Bun.spawn([codexBinary, "app-server"], {
      env: { ...Bun.env, CODEX_HOME: codexHome },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const rpc = new AppServerRpc(process);
    void rpc.consumeStdout();
    void rpc.consumeStderr();
    try {
      await rpc.request("initialize", {
        clientInfo: {
          name: "skizzles_installer",
          title: "Skizzles Installer",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      rpc.send({ method: "initialized" });
      return rpc;
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }

  async read(): Promise<ConfigReadResponse> {
    return parseConfigReadResponse(
      await this.request("config/read", { includeLayers: true, cwd: null }),
    );
  }

  async batchWrite(params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }): Promise<ConfigWriteResponse> {
    return parseConfigWriteResponse(
      await this.request("config/batchWrite", params),
    );
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    const exited = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ]);
    if (exited) {
      return;
    }
    this.process.kill();
    const terminated = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (terminated) {
      return;
    }
    this.process.kill(9);
    const killed = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (!killed) {
      throw new ConfigRpcError(
        "transport",
        "Codex app-server did not terminate after its input was closed",
      );
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ConfigRpcError(
            "transport",
            `Codex app-server request timed out (${safeMethodName(method)})`,
          ),
        );
      }, 15_000);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject,
        timeout,
      });
      this.send({ method, id, params });
    });
  }

  private send(message: object): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    this.process.stdin.flush();
  }

  private async consumeStdout(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        this.receive(line);
      }
    }
    const error = new ConfigRpcError(
      "transport",
      "Codex app-server closed unexpectedly",
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(line: string): void {
    if (!line.trim()) {
      return;
    }
    let value: unknown;
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

  private async consumeStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      decoder.decode(value, { stream: true });
    }
  }
}

function classifyProtocolError(error: {
  message?: string;
  data?: unknown;
  code?: unknown;
}): ConfigRpcError {
  const safeCode = configWriteErrorCode(error.data);
  if (safeCode === "configVersionConflict") {
    return new ConfigRpcError(
      "conflict",
      "Codex config version conflict; no config write was committed",
      "configVersionConflict",
    );
  }
  return new ConfigRpcError(
    "protocol",
    safeCode
      ? `Codex app-server rejected the request (${safeCode})`
      : "Codex app-server rejected the request",
    safeCode,
  );
}

function configWriteErrorCode(data: unknown): string | undefined {
  if (!isPlainObject(data)) {
    return undefined;
  }
  const value = data["config_write_error_code"];
  return typeof value === "string" && CONFIG_WRITE_ERROR_CODES.has(value)
    ? value
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfigReadResponse(value: unknown): ConfigReadResponse {
  if (!isPlainObject(value)) {
    throw invalidConfigResponse();
  }
  const layersValue = value["layers"];
  if (layersValue !== null && !Array.isArray(layersValue)) {
    throw invalidConfigResponse();
  }
  const layers =
    layersValue === null ? null : layersValue.map(parseConfigLayerResponse);
  const configValue = value["config"];
  if (configValue === undefined) {
    return { layers };
  }
  if (!isJsonValue(configValue)) {
    throw invalidConfigResponse();
  }
  return { config: configValue, layers };
}

function parseConfigLayerResponse(value: unknown): ConfigLayer {
  if (!(isPlainObject(value) && isPlainObject(value["name"]))) {
    throw invalidConfigResponse();
  }
  const nameValue = value["name"];
  const type = nameValue["type"];
  const file = nameValue["file"];
  const profile = nameValue["profile"];
  const version = value["version"];
  const config = value["config"];
  if (
    typeof type !== "string" ||
    (file !== undefined && typeof file !== "string") ||
    (profile !== undefined &&
      profile !== null &&
      typeof profile !== "string") ||
    typeof version !== "string" ||
    !isJsonValue(config)
  ) {
    throw invalidConfigResponse();
  }
  const name: ConfigLayer["name"] = { type };
  if (typeof file === "string") {
    name.file = file;
  }
  if (profile === null || typeof profile === "string") {
    name.profile = profile;
  }
  return { name, version, config };
}

function parseConfigWriteResponse(value: unknown): ConfigWriteResponse {
  if (
    !isPlainObject(value) ||
    typeof value["status"] !== "string" ||
    typeof value["version"] !== "string" ||
    typeof value["filePath"] !== "string"
  ) {
    throw invalidConfigResponse();
  }
  return {
    status: value["status"],
    version: value["version"],
    filePath: value["filePath"],
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
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

function invalidConfigResponse(): ConfigRpcError {
  return new ConfigRpcError(
    "protocol",
    "Codex app-server returned an invalid config response",
  );
}

function safeMethodName(method: string): string {
  return SAFE_METHOD_PATTERN.test(method) ? method : "unknown method";
}
