import { lstat, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { canonicalRoot, guardedPath } from "../../files.ts";
import type {
  DirectoryIdentity,
  SyncChange,
  SyncJournal,
} from "../contract.ts";
import { syncDirectory } from "./durability.ts";

export async function planCreatedDirectories(
  targetRoot: string,
  changes: SyncChange[],
): Promise<string[]> {
  const canonical = await canonicalRoot(targetRoot);
  const missing = new Set<string>();
  for (const change of changes) {
    for (const relative of await missingParentsForChange(canonical, change)) {
      missing.add(relative);
    }
  }
  return [...missing].sort();
}

export async function captureDeleteParentDirectories(
  targetRoot: string,
  changes: SyncChange[],
): Promise<DirectoryIdentity[]> {
  const canonical = await canonicalRoot(targetRoot);
  const parents = new Set<string>();
  for (const change of changes) {
    if (change.action !== "delete") {
      continue;
    }
    const parts = change.path.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index++) {
      parents.add(parts.slice(0, index).join("/"));
    }
  }
  const identities: DirectoryIdentity[] = [];
  for (const relative of [...parents].sort()) {
    identities.push(await directoryIdentity(canonical, relative));
  }
  return identities;
}

export async function assertDirectoryIdentities(
  targetRoot: string,
  identities: DirectoryIdentity[],
  message: (relative: string) => string,
): Promise<void> {
  for (const expected of identities) {
    let actual: DirectoryIdentity;
    try {
      actual = await directoryIdentity(targetRoot, expected.path);
    } catch {
      throw new Error(message(expected.path));
    }
    if (actual.device !== expected.device || actual.inode !== expected.inode) {
      throw new Error(message(expected.path));
    }
  }
}

async function missingParentsForChange(
  canonicalTarget: string,
  change: SyncChange,
): Promise<string[]> {
  const missing: string[] = [];
  const parts = change.path.split("/").slice(0, -1);
  for (let index = 1; index <= parts.length; index++) {
    const relative = parts.slice(0, index).join("/");
    try {
      const stat = await lstat(
        path.join(canonicalTarget, ...parts.slice(0, index)),
      );
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe synchronization parent for ${change.path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      missing.push(relative);
    }
  }
  return missing;
}

export async function createPlannedDirectories(
  targetRoot: string,
  directories: string[],
  onCreated: (identity: DirectoryIdentity) => void | Promise<void> = () =>
    undefined,
  beforeCreate: (relative: string) => void | Promise<void> = () => undefined,
  afterCreated: (relative: string) => void | Promise<void> = () => undefined,
): Promise<void> {
  for (const relative of directories) {
    await beforeCreate(relative);
    const directory = await guardedPath(targetRoot, relative);
    await mkdir(directory);
    await syncDirectory(path.dirname(directory));
    await afterCreated(relative);
    await onCreated(await directoryIdentity(targetRoot, relative));
  }
}

export interface CreatedDirectoryRetirementHooks {
  readonly beforeRemoval?: (
    identity: DirectoryIdentity,
  ) => void | Promise<void>;
  readonly afterRemoval?: (identity: DirectoryIdentity) => void | Promise<void>;
  readonly afterParentSync?: (
    identity: DirectoryIdentity,
  ) => void | Promise<void>;
}

async function assertCreatedDirectoriesRetirable(
  targetRoot: string,
  directories: DirectoryIdentity[],
): Promise<void> {
  const journalOwnedPaths = new Set(directories.map((entry) => entry.path));
  for (const identity of [...directories].reverse()) {
    await createdDirectoryRetirementState(
      targetRoot,
      identity,
      journalOwnedPaths,
    );
  }
}

export async function assertRecoveryDirectoryIdentities(
  targetRoot: string,
  journal: SyncJournal,
): Promise<void> {
  const conflict = (relative: string) =>
    `recovery conflict at ${relative}; divergent target directory preserved`;
  if (journal.state === "prepared") {
    await assertCreatedDirectoriesRetirable(
      targetRoot,
      journal.createdDirectories,
    );
  } else {
    await assertDirectoryIdentities(
      targetRoot,
      journal.createdDirectories,
      conflict,
    );
  }
  await assertDirectoryIdentities(
    targetRoot,
    journal.deleteParentDirectories,
    conflict,
  );
}

/**
 * Retire journal-owned directories deepest-first.
 *
 * A missing entry is an already completed retirement because every recorded
 * directory was absent before the prepared transaction created it. Present
 * entries still require their recorded identity and must be empty.
 */
export async function retireCreatedDirectories(
  targetRoot: string,
  directories: DirectoryIdentity[],
  hooks: CreatedDirectoryRetirementHooks = {},
): Promise<void> {
  const journalOwnedPaths = new Set(directories.map((entry) => entry.path));
  for (const identity of [...directories].reverse()) {
    await hooks.beforeRemoval?.(identity);
    const state = await createdDirectoryRetirementState(
      targetRoot,
      identity,
      journalOwnedPaths,
    );
    const directory = await guardedPath(targetRoot, identity.path);
    if (state === "absent") {
      await syncRetirementParent(directory, identity, journalOwnedPaths, hooks);
      continue;
    }
    try {
      await rmdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        await syncRetirementParent(
          directory,
          identity,
          journalOwnedPaths,
          hooks,
        );
        continue;
      }
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
        throw createdDirectoryConflict(identity.path);
      }
      throw error;
    }
    await hooks.afterRemoval?.(identity);
    await syncRetirementParent(directory, identity, journalOwnedPaths, hooks);
  }
}

async function syncRetirementParent(
  directory: string,
  identity: DirectoryIdentity,
  journalOwnedPaths: ReadonlySet<string>,
  hooks: CreatedDirectoryRetirementHooks,
): Promise<void> {
  try {
    await syncDirectory(path.dirname(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const parent = path.posix.dirname(identity.path);
      if (parent !== "." && journalOwnedPaths.has(parent)) {
        return;
      }
      throw createdDirectoryConflict(identity.path);
    }
    throw error;
  }
  await hooks.afterParentSync?.(identity);
}

async function createdDirectoryRetirementState(
  targetRoot: string,
  expected: DirectoryIdentity,
  journalOwnedPaths: ReadonlySet<string>,
): Promise<"absent" | "present"> {
  if (
    (await retirementAncestorState(
      targetRoot,
      expected.path,
      journalOwnedPaths,
    )) === "retired"
  ) {
    return "absent";
  }
  let actual: DirectoryIdentity;
  try {
    actual = await directoryIdentity(targetRoot, expected.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "absent";
    }
    throw createdDirectoryConflict(expected.path);
  }
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw createdDirectoryConflict(expected.path);
  }
  return "present";
}

async function retirementAncestorState(
  targetRoot: string,
  relative: string,
  journalOwnedPaths: ReadonlySet<string>,
): Promise<"intact" | "retired"> {
  const canonical = await canonicalRoot(targetRoot);
  const parts = relative.split("/").slice(0, -1);
  for (let index = 1; index <= parts.length; index++) {
    const ancestor = parts.slice(0, index).join("/");
    try {
      const stat = await lstat(path.join(canonical, ...parts.slice(0, index)));
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw createdDirectoryConflict(relative);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (journalOwnedPaths.has(ancestor)) {
        return "retired";
      }
      throw createdDirectoryConflict(relative);
    }
  }
  return "intact";
}

function createdDirectoryConflict(relative: string): Error {
  return new Error(
    `recovery conflict at ${relative}; divergent target directory preserved`,
  );
}

async function directoryIdentity(
  root: string,
  relative: string,
): Promise<DirectoryIdentity> {
  const directory = await guardedPath(root, relative);
  const stat = await lstat(directory, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe synchronization directory: ${relative}`);
  }
  return {
    path: relative,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
}
