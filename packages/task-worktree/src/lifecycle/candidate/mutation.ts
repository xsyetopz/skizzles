import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { TaskWorktreePrepareInput } from "../../contract.ts";
import { digestTaskWorktreeBytes } from "../../digest.ts";
import { isSafeRelativePath } from "../../policy/value.ts";

export async function mutate(
  root: string,
  change: TaskWorktreePrepareInput["changes"][number],
): Promise<boolean> {
  if (!isSafeRelativePath(change.path)) return false;
  const parent = await prepareParent(
    root,
    change.path,
    change.operation === "write",
  );
  if (parent === undefined) return false;
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") return false;
  const directoryFlags =
    fsConstants.O_RDONLY | noFollow | (fsConstants.O_DIRECTORY ?? 0);
  let parentHandle: FileHandle | undefined;
  try {
    parentHandle = await open(parent.parent, directoryFlags);
    const parentStat = await parentHandle.stat();
    if (!parentStat.isDirectory()) return false;
    if (!(await inspectTarget(root, change.path))) return false;
    if (change.operation === "delete")
      return await deleteExisting(root, parent.target, change);
    return await writeCandidate(root, parent.target, change, noFollow);
  } catch {
    return false;
  } finally {
    await parentHandle?.close().catch(() => undefined);
  }
}

export async function inspectTarget(
  root: string,
  path: string,
): Promise<boolean> {
  if (!isSafeRelativePath(path)) return false;
  const canonicalRoot = await canonicalDirectory(root);
  if (canonicalRoot === undefined) return false;
  const segments = path.split("/");
  let cursor = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) return false;
      if (index < segments.length - 1 && !metadata.isDirectory()) return false;
      if (
        index === segments.length - 1 &&
        (!metadata.isFile() || metadata.nlink !== 1)
      )
        return false;
      if (!withinRoot(canonicalRoot, await realpath(cursor))) return false;
    } catch (error) {
      if (!missing(error)) return false;
      return segments
        .slice(index)
        .every(
          (remaining) =>
            remaining !== "" && remaining !== "." && remaining !== "..",
        );
    }
  }
  return true;
}

interface PreparedParent {
  readonly parent: string;
  readonly target: string;
}

type SafeReadResult =
  | Readonly<{ status: "present"; bytes: Uint8Array }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "unsafe" }>;

async function canonicalDirectory(root: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    const resolved = await realpath(root);
    const resolvedMetadata = await lstat(resolved);
    if (!resolvedMetadata.isDirectory() || resolvedMetadata.isSymbolicLink())
      return;
    return resolved;
  } catch {
    return;
  }
}

async function prepareParent(
  root: string,
  path: string,
  create: boolean,
): Promise<PreparedParent | undefined> {
  const canonicalRoot = await canonicalDirectory(root);
  if (canonicalRoot === undefined || !isSafeRelativePath(path)) return;
  const segments = path.split("/");
  const leaf = segments.pop();
  if (leaf === undefined) return;
  let cursor = canonicalRoot;
  for (const segment of segments) {
    const next = join(cursor, segment);
    let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      metadata = await lstat(next);
    } catch (error) {
      if (!missing(error) || !create) return;
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (mkdirError) {
        if (!alreadyExists(mkdirError)) return;
      }
      try {
        metadata = await lstat(next);
      } catch {
        return;
      }
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    try {
      if (!withinRoot(canonicalRoot, await realpath(next))) return;
    } catch {
      return;
    }
    cursor = next;
  }
  if (!(await inspectParentDirectory(canonicalRoot, cursor))) return;
  return Object.freeze({ parent: cursor, target: join(cursor, leaf) });
}

async function inspectParentDirectory(
  root: string,
  parent: string,
): Promise<boolean> {
  try {
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    return withinRoot(root, await realpath(parent));
  } catch {
    return false;
  }
}

export async function readSafeFile(
  root: string,
  path: string,
): Promise<SafeReadResult> {
  if (!isSafeRelativePath(path) || !(await inspectTarget(root, path)))
    return Object.freeze({ status: "unsafe" });
  const parent = await prepareParent(root, path, false);
  if (parent === undefined) {
    return (await inspectTarget(root, path))
      ? Object.freeze({ status: "missing" })
      : Object.freeze({ status: "unsafe" });
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") return Object.freeze({ status: "unsafe" });
  let parentHandle: FileHandle | undefined;
  let handle: FileHandle | undefined;
  try {
    parentHandle = await open(
      parent.parent,
      fsConstants.O_RDONLY | noFollow | (fsConstants.O_DIRECTORY ?? 0),
    );
    const parentStat = await parentHandle.stat();
    if (!parentStat.isDirectory()) return Object.freeze({ status: "unsafe" });
    handle = await open(parent.target, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      return Object.freeze({ status: "unsafe" });
    const bytes = await readHandle(handle, before.size);
    const after = await handle.stat();
    if (
      !sameIdentity(before, after) ||
      after.nlink !== 1 ||
      !(await safeIdentityAtPath(root, path, after))
    )
      return Object.freeze({ status: "unsafe" });
    return Object.freeze({ status: "present", bytes });
  } catch (error) {
    if (missing(error)) return Object.freeze({ status: "missing" });
    return Object.freeze({ status: "unsafe" });
  } finally {
    await handle?.close().catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
  }
}

async function writeCandidate(
  root: string,
  target: string,
  change: TaskWorktreePrepareInput["changes"][number],
  noFollow: number,
): Promise<boolean> {
  const bytes = Uint8Array.from(change.candidateBytes ?? []);
  let handle: FileHandle | undefined;
  try {
    if (change.baselineDigest === null) {
      handle = await open(
        target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          noFollow,
        0o600,
      );
      const created = await handle.stat();
      if (!created.isFile() || created.nlink !== 1 || created.size !== 0)
        return false;
      if (!(await safeIdentityAtPath(root, change.path, created))) return false;
    } else {
      handle = await open(target, fsConstants.O_RDWR | noFollow);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1) return false;
      const baseline = await readHandle(handle, before.size);
      if (digestTaskWorktreeBytes(baseline) !== change.baselineDigest)
        return false;
      if (!(await safeIdentityAtPath(root, change.path, before))) return false;
      await handle.truncate(0);
    }
    await writeHandle(handle, bytes);
    await handle.sync();
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      !(await safeIdentityAtPath(root, change.path, after))
    )
      return false;
    const pathStat = await lstat(target);
    return sameIdentity(after, pathStat);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function deleteExisting(
  root: string,
  target: string,
  change: TaskWorktreePrepareInput["changes"][number],
): Promise<boolean> {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") return false;
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) return false;
    const bytes = await readHandle(handle, before.size);
    if (change.baselineDigest !== digestTaskWorktreeBytes(bytes)) return false;
    if (!(await safeIdentityAtPath(root, change.path, before))) return false;
    await handle.close();
    handle = undefined;
    if (!(await inspectTarget(root, change.path))) return false;
    const pathStat = await lstat(target);
    if (!sameIdentity(before, pathStat) || pathStat.nlink !== 1) return false;
    await unlink(target);
    try {
      await lstat(target);
      return false;
    } catch (error) {
      return missing(error);
    }
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readHandle(
  handle: FileHandle,
  size: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (result.bytesRead <= 0) throw new Error("short file read");
    offset += result.bytesRead;
  }
  return bytes;
}

async function writeHandle(
  handle: FileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (result.bytesWritten <= 0) throw new Error("short file write");
    offset += result.bytesWritten;
  }
}

async function safeIdentityAtPath(
  root: string,
  path: string,
  expected: { readonly dev: number; readonly ino: number },
): Promise<boolean> {
  if (!(await inspectTarget(root, path))) return false;
  const canonicalRoot = await canonicalDirectory(root);
  if (canonicalRoot === undefined) return false;
  try {
    return sameIdentity(expected, await lstat(join(canonicalRoot, path)));
  } catch {
    return false;
  }
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function withinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !fromRoot.startsWith("/"))
  );
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
