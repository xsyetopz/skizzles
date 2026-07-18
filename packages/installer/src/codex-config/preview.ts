import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathEntryExists } from "../managed-files.ts";
import { ConfigRpcError, parseConfigReadResponse } from "./rpc.ts";
import type {
  ConfigEdit,
  ConfigReadResponse,
  ConfigRpc,
  ConfigWriteResponse,
} from "./rpc-contract.ts";
import { canonicalExistingPath } from "./values.ts";

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

export function createConfigPreviewSnapshot(
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

export class PreviewConfigRpc implements ConfigRpc {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
