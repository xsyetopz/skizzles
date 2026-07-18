import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface StagedMove {
  from: string;
  to: string;
}

export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function copyDirectoryExclusive(
  source: string,
  target: string,
  copyEntry: (source: string, target: string) => void = (from, to) =>
    cpSync(from, to, { recursive: true }),
): void {
  mkdirSync(target);
  try {
    chmodSync(target, lstatSync(source).mode & 0o7777);
    for (const name of readdirSync(source)) {
      if (name === ".DS_Store") {
        continue;
      }
      copyEntry(join(source, name), join(target, name));
    }
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function assertManagedParentsAreReal(
  rootInput: string,
  managedParents: string[],
): void {
  const root = resolve(rootInput);
  for (const path of [
    root,
    ...managedParents.map((parent) => join(root, parent)),
  ]) {
    if (pathEntryExists(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to manage through a symlinked parent: ${path}`);
    }
  }
}

export function sameTree(left: string, right: string): boolean {
  if (!(existsSync(left) && existsSync(right))) {
    return false;
  }
  const leftStat = lstatSync(left);
  const rightStat = lstatSync(right);
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return false;
  }
  if (leftStat.isDirectory() !== rightStat.isDirectory()) {
    return false;
  }
  if ((leftStat.mode & 0o7777) !== (rightStat.mode & 0o7777)) {
    return false;
  }
  if (leftStat.isDirectory()) {
    const leftNames = readdirSync(left)
      .filter((name) => name !== ".DS_Store")
      .sort();
    const rightNames = readdirSync(right)
      .filter((name) => name !== ".DS_Store")
      .sort();
    if (leftNames.join("\0") !== rightNames.join("\0")) {
      return false;
    }
    return leftNames.every((name) =>
      sameTree(join(left, name), join(right, name)),
    );
  }
  return readFileSync(left).equals(readFileSync(right));
}

/**
 * Restores only entries that still have the exact staged shape: a source that
 * remains absent and a quarantine destination that remains present. This
 * prevents rollback from overwriting a replacement created after staging.
 */
export function rollbackStagedMoves(moved: readonly StagedMove[]): void {
  for (const item of [...moved].reverse()) {
    if (pathEntryExists(item.to) && !pathEntryExists(item.from)) {
      renameSync(item.to, item.from);
    }
  }
}
