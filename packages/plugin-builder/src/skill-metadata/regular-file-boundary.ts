import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { SkillMetadataError } from "./contract.ts";

interface StableRegularFile {
  bytes?: Uint8Array;
  size: number;
}

async function readStableRegularFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const file = await accessStableRegularFile(
    root,
    relativePath,
    maximumBytes,
    true,
  );
  if (file.bytes === undefined) {
    throw new SkillMetadataError(`${relativePath}: could not be read.`);
  }
  return file.bytes;
}

async function inspectStableRegularFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
): Promise<void> {
  await accessStableRegularFile(root, relativePath, maximumBytes, false);
}

async function accessStableRegularFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  readBytes: boolean,
): Promise<StableRegularFile> {
  assertContainedRelativePath(relativePath);
  const absolutePath = join(root, ...relativePath.split("/"));
  await assertNoSymlinkAncestors(root, relativePath);
  const before = await lstat(absolutePath).catch((error: unknown) => {
    throw filesystemError(error, relativePath);
  });
  validateRegularFile(before, relativePath, maximumBytes);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw filesystemError(error, relativePath);
  }
  try {
    const opened = await handle.stat();
    validateRegularFile(opened, relativePath, maximumBytes);
    assertSameIdentity(before, opened, relativePath);
    const bytes = readBytes ? await handle.readFile() : undefined;
    if (bytes !== undefined && bytes.byteLength !== opened.size) {
      throw changedDuringValidation(relativePath);
    }
    const openedAfterRead = await handle.stat();
    validateRegularFile(openedAfterRead, relativePath, maximumBytes);
    assertSameIdentity(opened, openedAfterRead, relativePath);
    const after = await lstat(absolutePath).catch((error: unknown) => {
      throw filesystemError(error, relativePath);
    });
    validateRegularFile(after, relativePath, maximumBytes);
    assertSameIdentity(opened, after, relativePath);
    return bytes === undefined
      ? { size: opened.size }
      : { bytes, size: opened.size };
  } finally {
    await handle.close();
  }
}

async function assertNoSymlinkAncestors(
  root: string,
  relativePath: string,
): Promise<void> {
  const parts = relativePath.split("/");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    // biome-ignore lint/performance/noAwaitInLoops: each ancestor must be checked before resolving the next path component.
    const metadata = await lstat(cursor).catch((error: unknown) => {
      throw filesystemError(error, relativePath);
    });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new SkillMetadataError(
        `${relativePath}: has an unsupported path ancestor.`,
      );
    }
  }
}

function validateRegularFile(
  metadata: Awaited<ReturnType<typeof lstat>>,
  relativePath: string,
  maximumBytes: number,
): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new SkillMetadataError(
      `${relativePath}: must be a self-contained regular file.`,
    );
  }
  if (metadata.nlink !== 1) {
    throw new SkillMetadataError(
      `${relativePath}: must have exactly one filesystem link.`,
    );
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    throw new SkillMetadataError(
      `${relativePath}: size must be between 1 and ${maximumBytes} bytes.`,
    );
  }
}

function assertSameIdentity(
  expected: Awaited<ReturnType<typeof lstat>>,
  actual: Awaited<ReturnType<typeof lstat>>,
  relativePath: string,
): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.size !== actual.size ||
    expected.mtimeMs !== actual.mtimeMs ||
    expected.ctimeMs !== actual.ctimeMs ||
    expected.mode !== actual.mode ||
    expected.nlink !== actual.nlink
  ) {
    throw changedDuringValidation(relativePath);
  }
}

function assertContainedRelativePath(relativePath: string): void {
  const normalized = relativePath.split("/").join(sep);
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    isAbsolute(normalized)
  ) {
    throw new SkillMetadataError(
      "Skill metadata path must remain within its declared root.",
    );
  }
}

function changedDuringValidation(relativePath: string): SkillMetadataError {
  return new SkillMetadataError(
    `${relativePath}: changed while its identity was being validated.`,
  );
}

function filesystemError(error: unknown, path: string): SkillMetadataError {
  if (isNodeError(error) && error.code === "ENOENT") {
    return new SkillMetadataError(`${path}: does not exist.`);
  }
  if (isNodeError(error) && error.code === "ELOOP") {
    return new SkillMetadataError(
      `${path}: must be a self-contained regular file.`,
    );
  }
  return new SkillMetadataError(`${path}: cannot be inspected safely.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export { inspectStableRegularFile, readStableRegularFile };
