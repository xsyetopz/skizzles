import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AgentContractPackageError } from "./contract.ts";
import type { JsonValue } from "./json-value.ts";
import { parseJsonAsset } from "./json-value.ts";

export interface ParsedAsset {
  bytes: Buffer;
  value: JsonValue;
}

interface PathIdentity {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
  target: boolean;
}

export async function readContainedJsonAsset(
  root: string,
  relativePath: string,
  label: string,
  afterOpen?: () => Promise<void>,
): Promise<ParsedAsset> {
  assertFixedRelativePath(relativePath, label);
  const paths = assetPaths(root, relativePath);
  const before = await snapshotPaths(paths, label);
  const target = before.at(-1);
  if (target === undefined) {
    throw new AgentContractPackageError(`${label} is missing or inaccessible.`);
  }
  const bytes = await readIdentityBound(target, label, afterOpen);
  await verifySnapshot(before, label);
  return { bytes, value: parseJsonAsset(bytes, label) };
}

function assetPaths(root: string, relativePath: string): string[] {
  const result = [root];
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    result.push(current);
  }
  return result;
}

async function snapshotPaths(
  paths: readonly string[],
  label: string,
): Promise<PathIdentity[]> {
  const result: PathIdentity[] = [];
  for (const [index, path] of paths.entries()) {
    const metadata = await safeLstat(path, label);
    const target = index === paths.length - 1;
    if (metadata.isSymbolicLink()) {
      throw new AgentContractPackageError(`${label} uses a symlinked path.`);
    }
    if (!target && !metadata.isDirectory()) {
      throw new AgentContractPackageError(
        `${label} has a non-directory parent.`,
      );
    }
    if (target && !metadata.isFile()) {
      throw new AgentContractPackageError(
        `${label} must be a non-symlink regular file.`,
      );
    }
    if (target && metadata.nlink !== 1) {
      throw new AgentContractPackageError(`${label} uses a hardlinked file.`);
    }
    result.push({
      path,
      dev: metadata.dev,
      ino: metadata.ino,
      target,
    });
  }
  return result;
}

async function verifySnapshot(
  expected: readonly PathIdentity[],
  label: string,
): Promise<void> {
  try {
    const actual = await snapshotPaths(
      expected.map((identity) => identity.path),
      label,
    );
    if (
      actual.some(
        (identity, index) =>
          identity.dev !== expected[index]?.dev ||
          identity.ino !== expected[index]?.ino ||
          identity.target !== expected[index]?.target,
      )
    ) {
      throw new AgentContractPackageError(
        `${label} ancestor identity changed during validation.`,
      );
    }
  } catch (error) {
    if (
      error instanceof AgentContractPackageError &&
      error.message.endsWith("ancestor identity changed during validation.")
    ) {
      throw error;
    }
    throw new AgentContractPackageError(
      `${label} ancestor identity changed during validation.`,
    );
  }
}

async function safeLstat(
  path: string,
  label: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path);
  } catch {
    throw new AgentContractPackageError(`${label} is missing or inaccessible.`);
  }
}

async function readIdentityBound(
  expected: PathIdentity,
  label: string,
  afterOpen?: () => Promise<void>,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      expected.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new AgentContractPackageError(`${label} is missing or inaccessible.`);
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino
    ) {
      throw new AgentContractPackageError(
        `${label} changed identity or uses a hardlinked file.`,
      );
    }
    await afterOpen?.();
    return await handle.readFile();
  } catch (error) {
    if (error instanceof AgentContractPackageError) {
      throw error;
    }
    throw new AgentContractPackageError(`${label} is missing or inaccessible.`);
  } finally {
    await handle.close();
  }
}

function assertFixedRelativePath(path: string, label: string): void {
  if (
    isAbsolute(path) ||
    path.length === 0 ||
    path.split("/").some((segment) => segment === "" || segment === "..")
  ) {
    throw new AgentContractPackageError(`${label} has an unsafe asset path.`);
  }
}
