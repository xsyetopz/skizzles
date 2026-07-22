import { type BigIntStats, constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { digestBytes } from "../../../digest.ts";
import { identity, sameIdentity } from "../identity.ts";
import type { StagedFile } from "./state.ts";

export async function writeOwnedFile(
  path: string,
  relativePath: string,
  bytes: Uint8Array,
  mode: number,
): Promise<StagedFile | undefined> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    if (!ownedRegularFile(stat) || stat.size !== BigInt(bytes.length)) return;
    return Object.freeze({
      path: relativePath,
      identity: identity(stat),
      bytes: bytes.length,
      digest: digestBytes(bytes),
    });
  } finally {
    await handle.close();
  }
}

export async function readTrustedFile(
  path: string,
  expected?: BigIntStats,
): Promise<Uint8Array | undefined> {
  const before = expected ?? (await lstat(path, { bigint: true }));
  if (!trustedRegularFile(before)) return;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameTrustedFile(opened, before)) return;
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameTrustedFile(after, before) ||
      after.size !== BigInt(bytes.length)
    ) {
      return;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function verifyOwnedFile(
  path: string,
  expected: StagedFile,
): Promise<boolean> {
  const before = await lstat(path, { bigint: true });
  if (!matchesOwnedFile(before, expected)) return false;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!matchesOwnedFile(opened, expected)) return false;
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    return (
      matchesOwnedFile(after, expected) &&
      digestBytes(bytes) === expected.digest
    );
  } finally {
    await handle.close();
  }
}

export function trustedDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

export function trustedRegularFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
}

function ownedRegularFile(stat: BigIntStats): boolean {
  return trustedRegularFile(stat) && (stat.mode & 0o077n) === 0n;
}

function matchesOwnedFile(stat: BigIntStats, expected: StagedFile): boolean {
  return (
    ownedRegularFile(stat) &&
    stat.size === BigInt(expected.bytes) &&
    sameIdentity(stat, expected.identity)
  );
}

function sameTrustedFile(actual: BigIntStats, expected: BigIntStats): boolean {
  return (
    trustedRegularFile(actual) &&
    actual.size === expected.size &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.birthtimeNs === expected.birthtimeNs
  );
}
