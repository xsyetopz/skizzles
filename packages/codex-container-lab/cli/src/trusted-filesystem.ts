import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type ExactDirectoryChainOptions = {
  canonicalMismatch?: "unsafe-indirection" | "not-exact-containment";
};

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
  let candidate = resolve(root);
  const rootInfo = await lstatIfPresent(candidate);
  if (!rootInfo) return false;
  assertRealDirectory(rootInfo, `configured ${label}`);
  let expected = await realpath(candidate);
  for (const segment of segments) {
    assertExactSegment(segment, label);
    candidate = join(candidate, segment);
    expected = join(expected, segment);
    if (!(await exactDirectory(candidate, expected, label, options))) {
      return false;
    }
  }
  return true;
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

async function lstatIfPresent(
  candidate: string,
): Promise<import("node:fs").Stats | undefined> {
  try {
    return await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function exactDirectory(
  candidate: string,
  expected: string,
  label: string,
  options: ExactDirectoryChainOptions,
): Promise<boolean> {
  const info = await lstatIfPresent(candidate);
  if (!info) return false;
  assertRealDirectory(info, label);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (canonical === expected) return true;
  if (options.canonicalMismatch === "unsafe-indirection") {
    throw new Error(`${label} contains unsafe indirection`);
  }
  throw new Error(`${label} is not exactly contained in its configured root`);
}

function assertRealDirectory(
  info: import("node:fs").Stats,
  label: string,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} contains unsafe indirection`);
  }
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
