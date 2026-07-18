import { type BigIntStats, constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AgentContractPackageError } from "./contract.ts";
import type { JsonValue } from "./json-value.ts";
import { parseJsonAsset } from "./json-value.ts";

export interface ParsedAsset {
  bytes: Buffer;
  value: JsonValue;
}

export const MAX_AGENT_CONTRACT_ASSET_BYTES = 1_048_576n;

export interface ExactFilesystemMetadata {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface PathIdentity extends ExactFilesystemMetadata {
  path: string;
  target: boolean;
  allocationSize: number;
}

export async function readContainedJsonAsset(
  root: string,
  relativePath: string,
  label: string,
  afterOpen?: () => Promise<void>,
  afterFirstRead?: () => Promise<void>,
  afterSnapshot?: () => Promise<void>,
): Promise<ParsedAsset> {
  assertFixedRelativePath(relativePath, label);
  const paths = assetPaths(root, relativePath);
  const before = await snapshotPaths(paths, label);
  const target = before.at(-1);
  if (target === undefined) {
    throw new AgentContractPackageError(`${label} is missing or inaccessible.`);
  }
  await afterSnapshot?.();
  const bytes = await readIdentityBound(
    target,
    label,
    afterOpen,
    afterFirstRead,
  );
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
    if (target && metadata.nlink !== 1n) {
      throw new AgentContractPackageError(`${label} uses a hardlinked file.`);
    }
    const exact = exactMetadata(metadata, label);
    const allocationSize = target ? boundedTargetSize(exact.size, label) : 0;
    result.push({
      path,
      target,
      allocationSize,
      ...exact,
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
          identity.target !== expected[index]?.target ||
          !exactFilesystemMetadataMatches(identity, expected[index]),
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

async function safeLstat(path: string, label: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    throw new AgentContractPackageError(`${label} is missing or inaccessible.`);
  }
}

async function readIdentityBound(
  expected: PathIdentity,
  label: string,
  afterOpen?: () => Promise<void>,
  afterFirstRead?: () => Promise<void>,
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
    const before = await handle.stat({ bigint: true });
    assertStableDescriptor(before, expected, label);
    await afterOpen?.();
    const first = await readAtStart(handle, expected.allocationSize + 1);
    await afterFirstRead?.();
    const second = await readAtStart(handle, expected.allocationSize + 1);
    const after = await handle.stat({ bigint: true });
    assertStableDescriptor(after, expected, label);
    if (first.length !== expected.allocationSize || !first.equals(second)) {
      throw new AgentContractPackageError(
        `${label} changed during identity-bound read.`,
      );
    }
    return first;
  } catch (error) {
    if (error instanceof AgentContractPackageError) {
      throw error;
    }
    throw new AgentContractPackageError(`${label} is missing or inaccessible.`);
  } finally {
    await handle.close();
  }
}

function assertStableDescriptor(
  metadata: BigIntStats,
  expected: PathIdentity,
  label: string,
): void {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    !exactFilesystemMetadataMatches(exactMetadata(metadata, label), expected)
  ) {
    throw new AgentContractPackageError(
      `${label} changed identity or uses a hardlinked file.`,
    );
  }
}

function boundedTargetSize(size: bigint, label: string): number {
  if (size < 1n || size > MAX_AGENT_CONTRACT_ASSET_BYTES) {
    throw new AgentContractPackageError(
      `${label} exceeds the bounded contract asset size.`,
    );
  }
  return Number(size);
}

function exactMetadata(
  metadata: BigIntStats,
  label: string,
): ExactFilesystemMetadata {
  const values = [
    metadata.dev,
    metadata.ino,
    metadata.nlink,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ];
  if (values.some((value) => typeof value !== "bigint" || value < 0n)) {
    throw new AgentContractPackageError(
      `${label} lacks exact bigint filesystem metadata.`,
    );
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

export function exactFilesystemMetadataMatches(
  left: ExactFilesystemMetadata,
  right: ExactFilesystemMetadata | undefined,
): boolean {
  return (
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readAtStart(
  handle: Awaited<ReturnType<typeof open>>,
  capacity: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(capacity);
  let offset = 0;
  while (offset < capacity) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      capacity - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
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
