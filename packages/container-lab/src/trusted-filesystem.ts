import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type ExactDirectoryChainOptions = {
  canonicalMismatch?: "unsafe-indirection" | "not-exact-containment";
};

type FileIdentity = { device: bigint; inode: bigint };
type DirectoryIdentity = FileIdentity & { path: string };

/** Canonicalize a directory while allowing the configured root itself to be a symlink. */
export async function canonicalDirectoryRoot(
  root: string,
  label: string,
): Promise<string> {
  const canonical = await realpath(root);
  const info = await lstat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${root}`);
  }
  return canonical;
}

/**
 * Require every named directory below a configured root to be a direct,
 * non-symlinked child. Missing roots or children are reported as absent.
 */
export async function exactDirectoryChain(
  root: string,
  segments: readonly string[],
  label: string,
  options: ExactDirectoryChainOptions = {},
): Promise<boolean> {
  return (
    (await exactDirectoryChainIdentity(root, segments, label, options)) !==
    undefined
  );
}

/**
 * Read a JSON file only while its exact parent chain and opened file identity
 * remain unchanged. The configured root and every descendant are no-follow.
 */
export async function readTrustedUnknownJson(
  root: string,
  parentSegments: readonly string[],
  fileName: string,
  label: string,
  options: ExactDirectoryChainOptions = {},
): Promise<unknown> {
  assertExactSegment(fileName, label);
  const before = await exactDirectoryChainIdentity(
    root,
    parentSegments,
    `${label} parent`,
    options,
  );
  const candidate = join(resolve(root), ...parentSegments, fileName);
  if (!before) {
    // Preserve the ordinary ENOENT contract for absent state.
    let unexpected: Awaited<ReturnType<typeof open>>;
    try {
      unexpected = await open(
        candidate,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`${label} contains unsafe indirection`);
      }
      throw error;
    }
    await unexpected.close();
    throw new Error(`${label} parent changed while being read`);
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${label} contains unsafe indirection`);
    }
    throw error;
  }
  try {
    const openedBefore = await handle.stat({ bigint: true });
    assertRealFile(openedBefore, label);
    await assertSameOpenedFile(candidate, openedBefore, label);
    const contents = await handle.readFile({ encoding: "utf8" });
    const openedAfter = await handle.stat({ bigint: true });
    if (!sameIdentity(openedBefore, openedAfter)) {
      throw new Error(`${label} changed while being read`);
    }
    const after = await exactDirectoryChainIdentity(
      root,
      parentSegments,
      `${label} parent`,
      options,
    );
    if (!(after && sameDirectoryChain(before, after))) {
      throw new Error(`${label} parent changed while being read`);
    }
    await assertSameOpenedFile(candidate, openedAfter, label);
    const value: unknown = JSON.parse(contents);
    return value;
  } finally {
    await handle.close();
  }
}

/** Read directory entries while rejecting parent replacement during the scan. */
export async function readTrustedDirectory(
  root: string,
  segments: readonly string[],
  label: string,
  options: ExactDirectoryChainOptions = {},
): Promise<import("node:fs").Dirent[] | undefined> {
  const before = await exactDirectoryChainIdentity(
    root,
    segments,
    label,
    options,
  );
  if (!before) {
    return undefined;
  }
  const entries = await readdir(join(resolve(root), ...segments), {
    withFileTypes: true,
  });
  const after = await exactDirectoryChainIdentity(
    root,
    segments,
    label,
    options,
  );
  if (!(after && sameDirectoryChain(before, after))) {
    throw new Error(`${label} changed while being read`);
  }
  return entries;
}

async function exactDirectoryChainIdentity(
  root: string,
  segments: readonly string[],
  label: string,
  options: ExactDirectoryChainOptions,
): Promise<DirectoryIdentity[] | undefined> {
  let candidate = resolve(root);
  const rootInfo = await lstatBigIntIfPresent(candidate);
  if (!rootInfo) {
    return undefined;
  }
  assertRealDirectory(rootInfo, `configured ${label}`);
  let expected = await realpath(candidate);
  const identities: DirectoryIdentity[] = [
    { path: candidate, device: rootInfo.dev, inode: rootInfo.ino },
  ];
  for (const segment of segments) {
    assertExactSegment(segment, label);
    candidate = join(candidate, segment);
    expected = join(expected, segment);
    const identity = await exactDirectory(candidate, expected, label, options);
    if (!identity) {
      return undefined;
    }
    identities.push({ path: candidate, ...identity });
  }
  return identities;
}

export async function realDirectory(
  candidate: string,
  label: string,
): Promise<string> {
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  return await realpath(candidate);
}

export async function assertRealFileInside(
  root: string,
  candidate: string,
  label: string,
): Promise<void> {
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a real file`);
  }
  assertCanonicalInside(root, await realpath(candidate), label, false);
}

export async function assertRealDirectoryInside(
  root: string,
  candidate: string,
  label: string,
): Promise<void> {
  const canonical = await realDirectory(candidate, label);
  assertCanonicalInside(root, canonical, label, true);
}

export function assertCanonicalInside(
  root: string,
  candidate: string,
  label: string,
  allowRoot: boolean,
): void {
  const fromRoot = relative(root, candidate);
  if (
    (!allowRoot && fromRoot === "") ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} resolves outside its trusted root`);
  }
}

async function lstatBigIntIfPresent(
  candidate: string,
): Promise<import("node:fs").BigIntStats | undefined> {
  try {
    return await lstat(candidate, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function exactDirectory(
  candidate: string,
  expected: string,
  label: string,
  options: ExactDirectoryChainOptions,
): Promise<FileIdentity | undefined> {
  const info = await lstatBigIntIfPresent(candidate);
  if (!info) {
    return undefined;
  }
  assertRealDirectory(info, label);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (canonical === expected) {
    return { device: info.dev, inode: info.ino };
  }
  if (options.canonicalMismatch === "unsafe-indirection") {
    throw new Error(`${label} contains unsafe indirection`);
  }
  throw new Error(`${label} is not exactly contained in its configured root`);
}

function assertRealDirectory(
  info: import("node:fs").Stats | import("node:fs").BigIntStats,
  label: string,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} contains unsafe indirection`);
  }
}

function assertRealFile(
  info: import("node:fs").BigIntStats,
  label: string,
): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a real file`);
  }
}

async function assertSameOpenedFile(
  candidate: string,
  opened: import("node:fs").BigIntStats,
  label: string,
): Promise<void> {
  const current = await lstat(candidate, { bigint: true });
  if (current.isSymbolicLink()) {
    throw new Error(`${label} contains unsafe indirection`);
  }
  assertRealFile(current, label);
  if (!sameIdentity(opened, current)) {
    throw new Error(`${label} changed while being read`);
  }
}

function sameIdentity(
  left: Pick<import("node:fs").BigIntStats, "dev" | "ino">,
  right: Pick<import("node:fs").BigIntStats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectoryChain(
  left: readonly DirectoryIdentity[],
  right: readonly DirectoryIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.path === right[index]?.path &&
        entry.device === right[index]?.device &&
        entry.inode === right[index]?.inode,
    )
  );
}

function assertExactSegment(segment: string, label: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    isAbsolute(segment)
  ) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
}
