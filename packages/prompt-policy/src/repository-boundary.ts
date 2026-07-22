import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_PATHS,
  LOCK_PATH,
  PromptLayerError,
  TRANSACTION_PATH,
} from "./lifecycle/contract.ts";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:/;

export interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

export function defaultPromptRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export async function canonicalRepoRoot(repoRoot: string): Promise<string> {
  const absolute = resolve(repoRoot);
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory()) {
    throw new PromptLayerError("Prompt repository root must be a directory.");
  }
  return realpath(absolute);
}

export async function assertCanonicalContainment(root: string): Promise<void> {
  for (const path of CANONICAL_PATHS) {
    await assertContainedPath(root, path, true);
  }
  await assertContainedPath(root, TRANSACTION_PATH, false);
  await assertContainedPath(root, LOCK_PATH, false);
}

/**
 * Containment protects against static symlinks and cooperating Skizzles writers
 * under the identity-bound exclusive lock. Node pathname APIs do not expose
 * dirfd/openat primitives, so this is not a race-free defense against an
 * unrelated malicious local process. Identity is rechecked immediately before
 * destructive pathname syscalls; detectable replacement races fail closed.
 */
export async function assertContainedPath(
  root: string,
  relativePath: string,
  mustExist: boolean,
): Promise<void> {
  validateSafeRelativePath(relativePath);
  const absolute = resolve(root, relativePath);
  if (!isWithinRoot(root, absolute)) {
    throw new PromptLayerError(
      `Prompt path ${relativePath} escapes the real repository root.`,
    );
  }
  let current = root;
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT" && !mustExist) {
        return;
      }
      throw new PromptLayerError(
        `Prompt path ${relativePath} cannot be safely inspected: ${errorMessage(error)}`,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new PromptLayerError(
        `Prompt path ${relativePath} has a symlinked ancestor or target.`,
      );
    }
    const resolved = await realpath(current);
    if (!isWithinRoot(root, resolved)) {
      throw new PromptLayerError(
        `Prompt path ${relativePath} resolves outside the repository root.`,
      );
    }
  }
}

export function validateSafeRelativePath(path: string): void {
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    WINDOWS_ABSOLUTE_PATH.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new PromptLayerError("Prompt patch path must be safe and relative.");
  }
}

function isWithinRoot(root: string, path: string): boolean {
  const relation = relative(root, path);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !relation.startsWith(sep))
  );
}

export function fileIdentity(
  metadata: Awaited<ReturnType<typeof lstat>>,
): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

export async function assertFilesystemIdentity(
  path: string,
  expected: FileIdentity,
  message: string,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new PromptLayerError(message);
  }
  const actual = fileIdentity(metadata);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new PromptLayerError(message);
  }
}

export async function removeOwnedTree(
  root: string,
  relativePath: string,
  identity: FileIdentity,
): Promise<void> {
  await assertContainedPath(root, relativePath, true);
  const absolute = join(root, relativePath);
  await assertFilesystemIdentity(
    absolute,
    identity,
    `Prompt lock artifact ${relativePath} changed before cleanup.`,
  );
  await rm(absolute, { recursive: true });
  await syncDirectory(dirname(absolute));
}

export async function writeDurably(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function writeAtomically(
  path: string,
  bytes: Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    if (await pathExists(temporary)) {
      await rm(temporary, { force: true });
      await syncDirectory(dirname(path));
    }
  }
}

export async function removeTreeDurably(
  root: string,
  relativePath: string,
): Promise<void> {
  await assertContainedPath(root, relativePath, true);
  const absolute = join(root, relativePath);
  await rm(absolute, { force: true, recursive: true });
  await syncDirectory(dirname(absolute));
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readRequiredFile(
  path: string,
  label: string,
): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    throw new PromptLayerError(`Cannot read ${label}: ${errorMessage(error)}`);
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
