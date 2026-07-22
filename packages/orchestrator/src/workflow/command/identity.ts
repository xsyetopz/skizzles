import type { BigIntStats } from "node:fs";

export type OwnedIdentity = Readonly<{
  readonly device: bigint;
  readonly inode: bigint;
  readonly birthtime: bigint;
}>;

export function identity(stat: BigIntStats): OwnedIdentity {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    birthtime: stat.birthtimeNs,
  });
}

export function sameIdentity(
  stat: BigIntStats,
  expected: OwnedIdentity,
): boolean {
  return (
    stat.dev === expected.device &&
    stat.ino === expected.inode &&
    stat.birthtimeNs === expected.birthtime
  );
}

export function privateDirectory(stat: BigIntStats): boolean {
  return (
    stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077n) === 0n
  );
}
