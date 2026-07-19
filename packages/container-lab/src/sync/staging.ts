import {
  chmod,
  copyFile,
  lstat,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import {
  describeSyncFile,
  guardedPath,
  type SyncFile,
  sha256,
} from "../files.ts";
import { assertExpectedEntry, sameSyncFile } from "./comparison.ts";
import type { BackupRecord, SyncChange } from "./contract.ts";
import { syncDirectory, syncFile } from "./durability.ts";

interface ParentIdentity {
  device: string;
  inode: string;
}

interface PublicationBoundary {
  parent: ParentIdentity;
  target: string;
}

class PublicationConflictError extends Error {
  constructor(relative: string, options?: ErrorOptions) {
    super(
      `Synchronization publication conflict at ${relative}; target preserved`,
      options,
    );
  }
}

export async function backupTargets(
  targetRoot: string,
  records: BackupRecord[],
): Promise<void> {
  for (const record of records) {
    await assertExpectedEntry(
      targetRoot,
      record.path,
      record.original,
      "target",
    );
    if (
      !(record.existed && record.backup && record.kind) ||
      record.mode === undefined
    ) {
      continue;
    }
    const target = await guardedPath(targetRoot, record.path);
    const stat = await lstat(target);
    if (record.kind === "symlink" && stat.isSymbolicLink()) {
      await symlink(await readlink(target), record.backup);
    } else if (record.kind === "file" && stat.isFile()) {
      await copyFile(target, record.backup);
      await chmod(record.backup, record.mode);
      await syncFile(record.backup);
    } else {
      throw new Error(
        `Synchronization target is not a regular file or symlink: ${record.path}`,
      );
    }
  }
  const backupDirectory = records.find((record) => record.backup)?.backup;
  if (backupDirectory) {
    await syncDirectory(path.dirname(backupDirectory));
  }
}

export async function planBackupRecords(
  targetRoot: string,
  changes: SyncChange[],
  expected: Record<string, SyncFile | null>,
  backupDir: string,
  journalId: string,
): Promise<BackupRecord[]> {
  const records: BackupRecord[] = [];
  for (const [index, change] of changes.entries()) {
    const original = expected[change.path] ?? null;
    const target = await guardedPath(targetRoot, change.path);
    const publication = path.join(
      path.dirname(target),
      `.skizzles-sync-${journalId}-${index}.tmp`,
    );
    records.push({
      path: change.path,
      existed: original !== null,
      ...(original
        ? {
            kind: original.kind,
            mode: original.mode,
            backup: path.join(backupDir, String(index)),
          }
        : {}),
      publication,
      original,
    });
  }
  return records;
}

export async function stageSources(
  sourceRoot: string,
  changes: SyncChange[],
  stagedRoot: string,
): Promise<void> {
  for (const change of changes) {
    await stageSourceChange(sourceRoot, stagedRoot, change);
  }
}

async function stageSourceChange(
  sourceRoot: string,
  stagedRoot: string,
  change: SyncChange,
): Promise<void> {
  if (change.action === "delete") {
    return;
  }
  if (!change.file) {
    throw new Error(
      `Synchronization preview is missing file details for ${change.path}`,
    );
  }
  const source = await guardedPath(sourceRoot, change.path);
  const target = await guardedPath(stagedRoot, change.path, true);
  const stat = await lstat(source);
  if (change.file.kind === "symlink" && stat.isSymbolicLink()) {
    await stageSymlink(source, target, change.file);
    return;
  }
  if (change.file.kind === "file" && stat.isFile()) {
    await copyFile(source, target);
    await chmod(target, change.file.mode);
    const staged = await describeSyncFile(stagedRoot, change.path);
    if (sameSyncFile(staged, change.file)) {
      return;
    }
    throw new Error("Synchronization preview is stale; source changed");
  }
  throw new Error(
    `Synchronization source changed type during apply: ${change.path}`,
  );
}

async function stageSymlink(
  source: string,
  target: string,
  expected: SyncFile,
): Promise<void> {
  const link = await readlink(source);
  const bytes = Buffer.from(link);
  if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) {
    throw new Error("Synchronization preview is stale; source changed");
  }
  await symlink(link, target);
}

async function parentIdentity(
  target: string,
  relative: string,
): Promise<ParentIdentity> {
  const stat = await lstat(path.dirname(target), { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PublicationConflictError(relative);
  }
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

async function capturePublicationBoundary(
  targetRoot: string,
  relative: string,
): Promise<PublicationBoundary> {
  const target = await guardedPath(targetRoot, relative);
  return { parent: await parentIdentity(target, relative), target };
}

async function assertPublicationBoundary(
  targetRoot: string,
  relative: string,
  expected: SyncFile | null,
  expectedParent: ParentIdentity,
): Promise<void> {
  try {
    const target = await guardedPath(targetRoot, relative);
    const actualParent = await parentIdentity(target, relative);
    if (
      actualParent.device !== expectedParent.device ||
      actualParent.inode !== expectedParent.inode
    ) {
      throw new PublicationConflictError(relative);
    }
    await assertExpectedEntry(targetRoot, relative, expected, "target");
  } catch (error) {
    if (error instanceof PublicationConflictError) {
      throw error;
    }
    throw new PublicationConflictError(relative, { cause: error });
  }
}

export async function applyChange(
  sourceRoot: string,
  targetRoot: string,
  change: SyncChange,
  record: BackupRecord,
  beforeRename?: () => void | Promise<void>,
): Promise<void> {
  const boundary = await capturePublicationBoundary(targetRoot, change.path);
  const { target } = boundary;
  if (change.action === "delete") {
    await beforeRename?.();
    await assertPublicationBoundary(
      targetRoot,
      change.path,
      record.original,
      boundary.parent,
    );
    await rm(target, { force: true, recursive: false });
    await syncDirectory(path.dirname(target));
    return;
  }
  if (!record.publication) {
    throw new Error(`Missing synchronization publication for ${change.path}`);
  }
  await assertPublicationAvailable(record.publication, change.path);
  const source = await guardedPath(sourceRoot, change.path);
  const stat = await lstat(source);
  try {
    if (change.file?.kind === "symlink" && stat.isSymbolicLink()) {
      await symlink(await readlink(source), record.publication);
    } else if (change.file?.kind === "file" && stat.isFile()) {
      await copyFile(source, record.publication);
      await chmod(record.publication, change.file.mode);
      await syncFile(record.publication);
    } else {
      throw new Error(
        `Synchronization source changed type during apply: ${change.path}`,
      );
    }
    await beforeRename?.();
    await assertPublicationBoundary(
      targetRoot,
      change.path,
      record.original,
      boundary.parent,
    );
    await rename(record.publication, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await rm(record.publication, { force: true, recursive: false }).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function restoreBackups(
  targetRoot: string,
  backups: BackupRecord[],
): Promise<void> {
  for (const record of backups) {
    const target = await guardedPath(targetRoot, record.path, true);
    if (!record.existed) {
      await rm(target, { force: true, recursive: false });
      await syncDirectory(path.dirname(target));
      continue;
    }
    if (!(record.backup && record.publication)) {
      throw new Error(`Missing synchronization backup for ${record.path}`);
    }
    await rm(record.publication, { force: true, recursive: false });
    if (record.kind === "symlink") {
      await symlink(await readlink(record.backup), record.publication);
    } else {
      await copyFile(record.backup, record.publication);
      if (record.mode !== undefined) {
        await chmod(record.publication, record.mode);
      }
      await syncFile(record.publication);
    }
    await rename(record.publication, target);
    await syncDirectory(path.dirname(target));
  }
}

export async function validateBackupArtifacts(
  backups: BackupRecord[],
): Promise<void> {
  for (const record of backups) {
    if (!(record.existed && record.backup && record.original)) {
      continue;
    }
    const actual = await describeSyncFile(
      path.dirname(record.backup),
      path.basename(record.backup),
    );
    if (!sameSyncFile(actual, record.original)) {
      throw new Error(`Invalid synchronization backup for ${record.path}`);
    }
  }
}

export async function cleanupPublications(
  backups: BackupRecord[],
): Promise<void> {
  for (const record of backups) {
    if (!record.publication) {
      continue;
    }
    await rm(record.publication, { force: true, recursive: false });
  }
}

async function assertPublicationAvailable(
  publication: string,
  relative: string,
): Promise<void> {
  try {
    await lstat(publication);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(
    `Synchronization publication path already exists: ${relative}`,
  );
}
