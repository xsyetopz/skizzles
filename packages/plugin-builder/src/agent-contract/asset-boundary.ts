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

export async function readContainedJsonAsset(
  root: string,
  relativePath: string,
  label: string,
): Promise<ParsedAsset> {
  assertFixedRelativePath(relativePath, label);
  await assertDirectory(root, `${label} root`);
  const segments = relativePath.split("/");
  let current = root;
  let targetIdentity:
    | { dev: number | bigint; ino: number | bigint }
    | undefined;

  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const metadata = await safeLstat(current, label);
    if (metadata.isSymbolicLink()) {
      throw new AgentContractPackageError(`${label} uses a symlinked path.`);
    }
    const isTarget = index === segments.length - 1;
    if (!isTarget && !metadata.isDirectory()) {
      throw new AgentContractPackageError(
        `${label} has a non-directory parent.`,
      );
    }
    if (isTarget && !metadata.isFile()) {
      throw new AgentContractPackageError(
        `${label} must be a non-symlink regular file.`,
      );
    }
    if (isTarget && metadata.nlink !== 1) {
      throw new AgentContractPackageError(`${label} uses a hardlinked file.`);
    }
    if (isTarget) {
      targetIdentity = { dev: metadata.dev, ino: metadata.ino };
    }
  }

  if (targetIdentity === undefined) {
    throw new AgentContractPackageError(`${label} is missing or inaccessible.`);
  }
  const bytes = await readWithoutFollowing(current, label, targetIdentity);
  return { bytes, value: parseJsonAsset(bytes, label) };
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const metadata = await safeLstat(path, label);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new AgentContractPackageError(
      `${label} must be a non-symlink directory.`,
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

async function readWithoutFollowing(
  path: string,
  label: string,
  expected: { dev: number | bigint; ino: number | bigint },
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
