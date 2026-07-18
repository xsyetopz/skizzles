import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AgentContractPackageError } from "./contract.ts";
import type { JsonValue } from "./json-value.ts";
import { parseJsonAsset } from "./json-value.ts";

export interface ParsedAsset {
  bytes: Buffer;
  value: JsonValue;
}

export const MAX_AGENT_CONTRACT_ASSET_BYTES = 1_048_576;

interface PathIdentity {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
  target: boolean;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
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
    if (target && metadata.nlink !== 1 && metadata.nlink !== 1n) {
      throw new AgentContractPackageError(`${label} uses a hardlinked file.`);
    }
    const size = statNumber(metadata.size, label);
    const nlink = statNumber(metadata.nlink, label);
    const mtimeMs = statTime(metadata.mtimeMs, label);
    const ctimeMs = statTime(metadata.ctimeMs, label);
    if (target) {
      assertSafeTargetSize(size, label);
    }
    result.push({
      path,
      dev: metadata.dev,
      ino: metadata.ino,
      target,
      nlink,
      size,
      mtimeMs,
      ctimeMs,
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
          identity.target !== expected[index]?.target ||
          (identity.target &&
            (identity.nlink !== expected[index]?.nlink ||
              identity.size !== expected[index]?.size ||
              identity.mtimeMs !== expected[index]?.mtimeMs ||
              identity.ctimeMs !== expected[index]?.ctimeMs)),
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
    const before = await handle.stat();
    assertStableDescriptor(before, expected, label);
    await afterOpen?.();
    const first = await readAtStart(handle, expected.size + 1);
    await afterFirstRead?.();
    const second = await readAtStart(handle, expected.size + 1);
    const after = await handle.stat();
    assertStableDescriptor(after, expected, label);
    if (first.length !== expected.size || !first.equals(second)) {
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
  metadata: Stats,
  expected: PathIdentity,
  label: string,
): void {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino ||
    metadata.size !== expected.size ||
    metadata.mtimeMs !== expected.mtimeMs ||
    metadata.ctimeMs !== expected.ctimeMs
  ) {
    throw new AgentContractPackageError(
      `${label} changed identity or uses a hardlinked file.`,
    );
  }
}

function assertSafeTargetSize(size: number, label: string): void {
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_AGENT_CONTRACT_ASSET_BYTES
  ) {
    throw new AgentContractPackageError(
      `${label} exceeds the bounded contract asset size.`,
    );
  }
}

function statNumber(value: number | bigint, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new AgentContractPackageError(
      `${label} has unsafe filesystem metadata.`,
    );
  }
  return number;
}

function statTime(value: number | bigint, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(number) || number < 0) {
    throw new AgentContractPackageError(
      `${label} has unsafe filesystem metadata.`,
    );
  }
  return number;
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
