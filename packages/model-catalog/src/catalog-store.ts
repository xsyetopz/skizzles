import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import {
  assertCompleteCatalog,
  type JsonObject,
  parseCatalogCache,
  parseJson,
} from "./catalog-schema.ts";

export const MODEL_CACHE_TTL_MS = 300_000;

export interface CatalogStorePaths {
  codexHome: string;
  output: string;
  status: string;
  cache: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface TargetSnapshot {
  parent: FileIdentity;
  target?: FileIdentity;
  targetCtimeMs?: number;
  targetNlink?: number;
  targetMode?: number;
  targetMtimeMs?: number;
  targetSize?: number;
}

interface TargetInspection {
  physicalPath: string;
  identity?: FileIdentity;
  metadata?: Stats;
}

function physicalPathKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

export interface AtomicWriteOptions {
  beforePromote?: () => Promise<void>;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function identity(metadata: Stats): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(
  first: FileIdentity | undefined,
  second: FileIdentity | undefined,
): boolean {
  if (first === undefined || second === undefined) {
    return first === second;
  }
  return first.dev === second.dev && first.ino === second.ino;
}

function pathComponents(path: string): string[] {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const segments = absolute
    .slice(root.length)
    .split(sep)
    .filter((segment) => segment.length > 0);
  const paths = [root];
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    paths.push(current);
  }
  return paths;
}

async function existingPathMetadata(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

async function rejectSymlinkAncestors(path: string): Promise<void> {
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

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

async function firstMissingComponent(
  path: string,
): Promise<string | undefined> {
  for (const component of pathComponents(path)) {
    if ((await existingPathMetadata(component)) === undefined) {
      return component;
    }
  }
  return undefined;
}

async function ensureDirectoryPath(path: string): Promise<void> {
  await rejectSymlinkAncestors(path);
  for (const component of pathComponents(path)) {
    const metadata = await existingPathMetadata(component);
    if (metadata === undefined) {
      await mkdir(component, { mode: 0o700 });
      const created = await lstat(component);
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

function privateMode(metadata: Stats): boolean {
  return (metadata.mode & 0o777) === 0o700;
}

async function validatePrivateDirectoryChain(
  privacyRoot: string,
  directory: string,
): Promise<void> {
  if (!within(privacyRoot, directory)) {
    throw new Error(`${directory} escapes its private storage root`);
  }
  await rejectSymlinkAncestors(directory);
  const expectedUid = process.getuid?.();
  for (const component of pathComponents(directory)) {
    if (!within(privacyRoot, component)) {
      continue;
    }
    const metadata = await lstat(component);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${component} must be a directory`);
    }
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
      throw new Error(`${component} must be owned by the current user`);
    }
    if (!privateMode(metadata)) {
      throw new Error(`${component} must have mode 0700`);
    }
    if ((await realpath(component)) !== component) {
      throw new Error(`${component} must use its physical path`);
    }
  }
}

async function privacyRootFor(
  codexHome: string,
  directory: string,
): Promise<string> {
  if (within(codexHome, directory)) {
    return codexHome;
  }
  return (await firstMissingComponent(directory)) ?? directory;
}

async function preparePrivateParent(
  codexHome: string,
  target: string,
): Promise<void> {
  const directory = dirname(target);
  const privacyRoot = await privacyRootFor(codexHome, directory);
  await ensureDirectoryPath(directory);
  await validatePrivateDirectoryChain(privacyRoot, directory);
}

async function prepareStandaloneParent(target: string): Promise<void> {
  const directory = dirname(target);
  const privacyRoot = (await firstMissingComponent(directory)) ?? directory;
  await ensureDirectoryPath(directory);
  await validatePrivateDirectoryChain(privacyRoot, directory);
}

async function regularFileMetadata(path: string): Promise<Stats> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${path} must not be a symlink`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${path} must be a regular file`);
  }
  return metadata;
}

function requireSingleLink(path: string, metadata: Stats): Stats {
  if (metadata.nlink !== 1) {
    throw new Error(`${path} must have exactly one hard link`);
  }
  return metadata;
}

async function managedFileMetadata(path: string): Promise<Stats> {
  return requireSingleLink(path, await regularFileMetadata(path));
}

export async function validatePhysicalRegularFile(path: string): Promise<void> {
  await rejectSymlinkAncestors(path);
  await regularFileMetadata(path);
}

export async function validatePhysicalDirectory(path: string): Promise<void> {
  await rejectSymlinkAncestors(path);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${path} must be a directory`);
  }
  if ((await realpath(path)) !== path) {
    throw new Error(`${path} must use its physical path`);
  }
}

async function inspectTarget(path: string): Promise<TargetInspection> {
  await rejectSymlinkAncestors(path);
  const physicalParent = await realpath(dirname(path));
  if (physicalParent !== dirname(path)) {
    throw new Error(`${path} must use its physical parent path`);
  }
  const metadata = await existingPathMetadata(path);
  if (metadata === undefined) {
    return { physicalPath: join(physicalParent, basename(path)) };
  }
  const regular = await managedFileMetadata(path);
  return {
    physicalPath: join(physicalParent, basename(path)),
    identity: identity(regular),
    metadata: regular,
  };
}

async function ensurePrivateFileMode(path: string): Promise<void> {
  const metadata = await existingPathMetadata(path);
  if (metadata === undefined) {
    return;
  }
  const regular = await managedFileMetadata(path);
  const expectedUid = process.getuid?.();
  if (expectedUid !== undefined && regular.uid !== expectedUid) {
    throw new Error(`${path} must be owned by the current user`);
  }
  if ((regular.mode & 0o777) === 0o600) {
    return;
  }
  const expected = identity(regular);
  await chmod(path, 0o600);
  const repaired = await managedFileMetadata(path);
  if (!sameIdentity(expected, identity(repaired))) {
    throw new Error(`${path} changed during permission repair`);
  }
}

async function targetSnapshot(path: string): Promise<TargetSnapshot> {
  const parent = await lstat(dirname(path));
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
    ...(target === undefined
      ? {}
      : {
          target: identity(target),
          targetCtimeMs: target.ctimeMs,
          targetMode: target.mode & 0o777,
          targetMtimeMs: target.mtimeMs,
          targetNlink: target.nlink,
          targetSize: target.size,
        }),
  };
}

async function assertSnapshotUnchanged(
  path: string,
  expected: TargetSnapshot,
): Promise<void> {
  await rejectSymlinkAncestors(path);
  const current = await targetSnapshot(path);
  if (
    !(
      sameIdentity(current.parent, expected.parent) &&
      sameIdentity(current.target, expected.target)
    ) ||
    current.targetCtimeMs !== expected.targetCtimeMs ||
    current.targetMode !== expected.targetMode ||
    current.targetMtimeMs !== expected.targetMtimeMs ||
    current.targetNlink !== expected.targetNlink ||
    current.targetSize !== expected.targetSize
  ) {
    throw new Error(`${path} changed during atomic replacement`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function prepareCatalogStorePaths(
  paths: CatalogStorePaths,
): Promise<void> {
  for (const path of [paths.output, paths.status, paths.cache]) {
    if (!isAbsolute(path)) {
      throw new Error(`${path} must be absolute`);
    }
    await preparePrivateParent(paths.codexHome, path);
    await ensurePrivateFileMode(path);
  }
  await validateCatalogStorePaths(paths);
}

async function validateCatalogTarget(
  paths: CatalogStorePaths,
  path: string,
): Promise<TargetInspection> {
  const directory = dirname(path);
  const privacyRoot = await privacyRootFor(paths.codexHome, directory);
  await validatePrivateDirectoryChain(privacyRoot, directory);
  const inspection = await inspectTarget(path);
  if (inspection.metadata === undefined) {
    return inspection;
  }
  const expectedUid = process.getuid?.();
  if (
    (expectedUid !== undefined && inspection.metadata.uid !== expectedUid) ||
    (inspection.metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${path} must be an owner-only mode 0600 file`);
  }
  return inspection;
}

function assertDistinctInspections(
  first: TargetInspection,
  second: TargetInspection,
): void {
  const samePath =
    physicalPathKey(first.physicalPath) ===
    physicalPathKey(second.physicalPath);
  const sameFile =
    first.identity !== undefined &&
    second.identity !== undefined &&
    sameIdentity(first.identity, second.identity);
  if (samePath || sameFile) {
    throw new Error(
      "catalog output, status, and cache paths must be physically distinct",
    );
  }
}

export async function validateCatalogStorePaths(
  paths: CatalogStorePaths,
): Promise<void> {
  const inspections = await Promise.all(
    [paths.output, paths.status, paths.cache].map((path) =>
      validateCatalogTarget(paths, path),
    ),
  );
  for (let left = 0; left < inspections.length; left += 1) {
    for (let right = left + 1; right < inspections.length; right += 1) {
      const first = inspections[left];
      const second = inspections[right];
      if (first === undefined || second === undefined) {
        continue;
      }
      assertDistinctInspections(first, second);
    }
  }
}

export async function readBoundedJsonFile(
  path: string,
  maxBytes: number,
): Promise<unknown> {
  const metadata = await managedFileMetadata(path);
  if (metadata.size > maxBytes) {
    throw new Error("catalog input exceeds size limit");
  }
  const handle = await open(path, "r");
  try {
    const opened = requireSingleLink(path, await handle.stat());
    if (
      !(opened.isFile() && sameIdentity(identity(metadata), identity(opened)))
    ) {
      throw new Error(`${path} changed while opening catalog input`);
    }
    const contents = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < contents.byteLength) {
      const { bytesRead } = await handle.read(
        contents,
        length,
        contents.byteLength - length,
        null,
      );
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

export async function cachedCatalog(
  path: string,
  expectedVersion: string,
  now: Date,
  maxBytes: number,
): Promise<JsonObject | undefined> {
  try {
    const root = parseCatalogCache(await readBoundedJsonFile(path, maxBytes));
    if (root.client_version !== expectedVersion) {
      return undefined;
    }
    const fetchedAt = Date.parse(root.fetched_at);
    const age = now.getTime() - fetchedAt;
    if (!Number.isFinite(fetchedAt) || age < 0 || age > MODEL_CACHE_TTL_MS) {
      return undefined;
    }
    return assertCompleteCatalog({ models: root.models });
  } catch {
    return undefined;
  }
}

async function validatedAtomicParent(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error(`${path} must be absolute`);
  }
  await prepareStandaloneParent(path);
  await rejectSymlinkAncestors(path);
  const parent = dirname(path);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${parent} must be a directory`);
  }
  if (!privateMode(metadata)) {
    throw new Error(`${parent} must have mode 0700`);
  }
  const expectedUid = process.getuid?.();
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error(`${parent} must be owned by the current user`);
  }
  return parent;
}

async function preparedTarget(
  path: string,
  contents: string,
): Promise<{ expected: TargetSnapshot; unchanged: boolean }> {
  let expected = await targetSnapshot(path);
  if (expected.target === undefined) {
    return { expected, unchanged: false };
  }
  if (expected.targetMode !== 0o600) {
    await chmod(path, 0o600);
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

async function writeSyncedTemporary(
  temporary: string,
  contents: string,
): Promise<TargetSnapshot> {
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      const opened = requireSingleLink(temporary, await handle.stat());
      if ((opened.mode & 0o777) !== 0o600) {
        throw new Error(`${temporary} must have mode 0600`);
      }
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      const completed = requireSingleLink(temporary, await handle.stat());
      if (
        !sameIdentity(identity(opened), identity(completed)) ||
        (completed.mode & 0o777) !== 0o600
      ) {
        throw new Error(`${temporary} changed while staging atomic output`);
      }
    } finally {
      await handle.close();
    }
    return await targetSnapshot(temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function promoteTemporary(
  path: string,
  parent: string,
  temporary: string,
  temporaryExpected: TargetSnapshot,
  expected: TargetSnapshot,
  options: AtomicWriteOptions,
): Promise<void> {
  await assertSnapshotUnchanged(path, expected);
  await assertSnapshotUnchanged(temporary, temporaryExpected);
  await options.beforePromote?.();
  await assertSnapshotUnchanged(path, expected);
  await assertSnapshotUnchanged(temporary, temporaryExpected);
  await rename(temporary, path);
  await syncDirectory(parent);
  const promoted = await managedFileMetadata(path);
  if (
    (promoted.mode & 0o777) !== 0o600 ||
    !sameIdentity(identity(promoted), temporaryExpected.target)
  ) {
    throw new Error(`${path} must have mode 0600`);
  }
}

export async function writePrivateAtomic(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<boolean> {
  const parent = await validatedAtomicParent(path);
  const target = await preparedTarget(path, contents);
  if (target.unchanged) {
    return false;
  }
  const temporary = join(parent, `.${globalThis.crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const temporaryExpected = await writeSyncedTemporary(temporary, contents);
    created = true;
    await promoteTemporary(
      path,
      parent,
      temporary,
      temporaryExpected,
      target.expected,
      options,
    );
    created = false;
    return true;
  } finally {
    if (created) {
      await rm(temporary, { force: true });
    }
  }
}

export function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}
