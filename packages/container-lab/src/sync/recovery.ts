import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import {
  canonicalRoot,
  describeSyncFile,
  guardedPath,
  type SyncFile,
} from "../files.ts";
import { sameSyncFile } from "./comparison.ts";
import type {
  BackupRecord,
  RecoverSyncOptions,
  StoredPreview,
  SyncJournal,
} from "./contract.ts";
import { writeDurableJson } from "./durability.ts";
import { manifestDigest } from "./git-manifest.ts";
import { previewBinding } from "./preview.ts";
import {
  assertDirectoryIdentities,
  cleanupCreatedDirectories,
  cleanupPublications,
  restoreBackups,
  validateBackupArtifacts,
} from "./staging.ts";
import {
  readRequiredUnknownJson,
  type SyncStatePaths,
  syncStatePaths,
} from "./state.ts";
import { parseSyncJournal } from "./validation/journal.ts";
import { parseBaselineFile, parseStoredPreview } from "./validation/preview.ts";

const JOURNAL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Recover interrupted applies. Prepared journals roll back; fully applied journals publish their baseline. */
export async function recoverSyncTransactions(
  options: RecoverSyncOptions,
): Promise<number> {
  const state = await syncStatePaths(options);
  const allowedTargets = new Set(
    await Promise.all(options.allowedTargetRoots.map(canonicalRoot)),
  );
  const glob = new Bun.Glob("*.json");
  let recovered = 0;
  for await (const name of glob.scan({
    cwd: state.journals,
    onlyFiles: true,
  })) {
    await recoverJournal(state, name, allowedTargets, options.labId);
    recovered++;
  }
  return recovered;
}

async function recoverJournal(
  state: SyncStatePaths,
  name: string,
  allowedTargets: Set<string>,
  labId: string,
): Promise<void> {
  const journalId = path.basename(name, ".json");
  if (!JOURNAL_ID.test(journalId)) {
    throw new Error(`Invalid synchronization journal ${name}`);
  }
  const journalPath = path.join(state.journals, name);
  const journal = parseSyncJournal(
    await readRequiredUnknownJson(
      journalPath,
      `Invalid synchronization journal ${name}`,
    ),
  );
  const provenance = await validateJournalProvenance(
    state,
    journal,
    journalId,
    allowedTargets,
    labId,
  );
  const backupDir = path.join(state.backups, journalId);
  await recoverJournalState(state, journal, journalPath, backupDir, provenance);
  await rm(backupDir, { recursive: true, force: true });
  await rm(journalPath, { force: true });
}

async function recoverJournalState(
  state: SyncStatePaths,
  journal: SyncJournal,
  journalPath: string,
  backupDir: string,
  provenance: { targetRoot: string; baselinePublished: boolean },
): Promise<void> {
  const { targetRoot } = provenance;
  if (
    journal.state === "prepared" ||
    (journal.state === "applied" && !provenance.baselinePublished)
  ) {
    await assertRecoveryDirectoryIdentities(targetRoot, journal);
    await validateBackupDirectory(backupDir);
    await validateBackupArtifacts(journal.backups);
  }
  if (journal.state === "applied" && !provenance.baselinePublished) {
    await assertAppliedTargets(targetRoot, journal);
    await writeDurableJson(state.baseline, journal.newBaseline);
  } else if (journal.state === "prepared") {
    await rollbackJournalSafely(targetRoot, journal);
  }
  if (journal.state === "prepared") {
    await cleanupPublications(
      journal.backups.filter((backup) =>
        journal.mutatedPaths.includes(backup.path),
      ),
    );
    await cleanupCreatedDirectories(targetRoot, journal.createdDirectories);
  }
  if (journal.state === "prepared") {
    journal.createdDirectories = [];
    journal.state = "rolledBack";
  } else if (journal.state === "applied") {
    journal.state = "committed";
  }
  if (journal.state === "rolledBack" || journal.state === "committed") {
    await writeDurableJson(journalPath, journal);
  }
}

async function assertAppliedTargets(
  targetRoot: string,
  journal: SyncJournal,
): Promise<void> {
  for (const backup of journal.backups) {
    let actual: SyncFile | null = null;
    try {
      actual = await describeSyncFile(targetRoot, backup.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const intended = journal.appliedStates[backup.path] ?? null;
    if (!sameSyncFile(actual ?? undefined, intended ?? undefined)) {
      throw new Error(
        `recovery conflict at ${backup.path}; divergent target preserved`,
      );
    }
  }
}

async function validateJournalProvenance(
  state: SyncStatePaths,
  journal: SyncJournal,
  journalId: string,
  allowedTargets: Set<string>,
  expectedLabId: string,
): Promise<{ targetRoot: string; baselinePublished: boolean }> {
  const preview = parseStoredPreview(
    await readRequiredUnknownJson(
      path.join(state.used, `${journal.previewToken}.json`),
      "Synchronization journal preview provenance is missing",
    ),
  );
  if (
    preview.token !== journal.previewToken ||
    preview.labId !== expectedLabId ||
    preview.binding !== journal.previewBinding ||
    preview.binding !== previewBinding(preview)
  ) {
    throw new Error("Invalid synchronization journal preview provenance");
  }
  const currentBaseline = parseBaselineFile(
    await readRequiredUnknownJson(
      state.baseline,
      "Synchronization journal baseline is missing",
    ),
  );
  const currentBaselineDigest = manifestDigest(currentBaseline.files);
  const baselinePublished =
    (journal.state === "applied" || journal.state === "committed") &&
    currentBaselineDigest === preview.sourceDigest;
  if (!baselinePublished && currentBaselineDigest !== preview.baselineDigest) {
    throw new Error("Invalid synchronization journal baseline provenance");
  }
  if (journal.state === "committed" && !baselinePublished) {
    throw new Error("Invalid committed synchronization journal baseline");
  }
  const targetRoot = await canonicalRoot(journal.targetRoot);
  if (
    targetRoot !== journal.targetRoot ||
    targetRoot !== preview.targetRoot ||
    !allowedTargets.has(targetRoot)
  ) {
    throw new Error(
      `Synchronization journal targets a root not owned by this lab: ${targetRoot}`,
    );
  }
  const expectedBaseline = path.join(
    await canonicalRoot(path.dirname(state.baseline)),
    path.basename(state.baseline),
  );
  if (journal.baselinePath !== expectedBaseline) {
    throw new Error(
      "Synchronization journal baseline does not belong to this lab",
    );
  }
  assertJournalMatchesPreview(journal, preview);
  await resolveCreatingDirectory(
    targetRoot,
    journal,
    path.join(state.journals, `${journalId}.json`),
  );
  if (
    journal.state === "prepared" ||
    (journal.state === "applied" && !baselinePublished)
  ) {
    await assertRecoveryDirectoryIdentities(targetRoot, journal);
  }
  await validateJournalRecords(state, journal, journalId, targetRoot);
  return { targetRoot, baselinePublished };
}

function assertJournalMatchesPreview(
  journal: SyncJournal,
  preview: StoredPreview,
): void {
  if (
    preview.conflicts.length > 0 ||
    journal.backups.length !== preview.changes.length ||
    !journalDirectoriesMatchPreview(journal, preview) ||
    JSON.stringify(journal.deleteParentDirectories) !==
      JSON.stringify(preview.deleteParentDirectories) ||
    manifestDigest(journal.newBaseline.files) !== preview.sourceDigest
  ) {
    throw new Error("Invalid synchronization journal semantic provenance");
  }
  for (const [index, change] of preview.changes.entries()) {
    const backup = journal.backups[index];
    if (!backup || backup.path !== change.path) {
      throw new Error("Invalid synchronization journal backup coverage");
    }
    if (
      !(
        sameSyncFile(
          backup.original ?? undefined,
          preview.expectedTargets[change.path] ?? undefined,
        ) &&
        sameSyncFile(
          journal.appliedStates[change.path] ?? undefined,
          change.file,
        )
      )
    ) {
      throw new Error(
        `Invalid synchronization journal descriptor provenance for ${change.path}`,
      );
    }
  }
}

function journalDirectoriesMatchPreview(
  journal: SyncJournal,
  preview: StoredPreview,
): boolean {
  const createdPaths = journal.createdDirectories.map((entry) => entry.path);
  if (journal.state === "applied" || journal.state === "committed") {
    return (
      JSON.stringify(createdPaths) ===
      JSON.stringify(preview.missingTargetDirectories)
    );
  }
  if (
    journal.creatingDirectory !== undefined &&
    !preview.missingTargetDirectories.includes(journal.creatingDirectory)
  ) {
    return false;
  }
  if (journal.state === "preparing" || journal.state === "rolledBack") {
    return createdPaths.length === 0;
  }
  return createdPaths.every((directory) =>
    preview.missingTargetDirectories.includes(directory),
  );
}

async function resolveCreatingDirectory(
  targetRoot: string,
  journal: SyncJournal,
  journalPath: string,
): Promise<void> {
  const relative = journal.creatingDirectory;
  if (!relative) {
    return;
  }
  try {
    await lstat(path.join(targetRoot, ...relative.split("/")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    delete journal.creatingDirectory;
    await writeDurableJson(journalPath, journal);
    return;
  }
  throw new Error(
    `recovery conflict at ${relative}; unverified target directory preserved`,
  );
}

async function validateJournalRecords(
  state: SyncStatePaths,
  journal: SyncJournal,
  journalId: string,
  targetRoot: string,
): Promise<void> {
  const backupRoot = path.join(state.backups, journalId, "target");
  for (const [index, backup] of journal.backups.entries()) {
    const expectedBackup = path.join(backupRoot, String(index));
    if (
      backup.existed
        ? backup.backup !== expectedBackup
        : backup.backup !== undefined
    ) {
      throw new Error(
        `Invalid synchronization backup provenance for ${backup.path}`,
      );
    }
    const target = await guardedPath(targetRoot, backup.path);
    const expectedPublication = path.join(
      path.dirname(target),
      `.skizzles-sync-${journalId}-${index}.tmp`,
    );
    if (backup.publication !== expectedPublication) {
      throw new Error(
        `Invalid synchronization publication provenance for ${backup.path}`,
      );
    }
    const intended = journal.appliedStates[backup.path];
    const baselineValue = journal.newBaseline.files[backup.path];
    if (!sameSyncFile(intended ?? undefined, baselineValue)) {
      throw new Error(
        `Invalid synchronization baseline provenance for ${backup.path}`,
      );
    }
  }
  const expectedMutated = journal.backups
    .slice(0, journal.mutatedPaths.length)
    .map((backup) => backup.path);
  if (
    JSON.stringify(journal.mutatedPaths) !== JSON.stringify(expectedMutated)
  ) {
    throw new Error("Invalid synchronization mutation order");
  }
  if (
    (journal.state === "applied" || journal.state === "committed") &&
    journal.mutatedPaths.length !== journal.backups.length
  ) {
    throw new Error("Invalid applied synchronization journal coverage");
  }
}

async function validateBackupDirectory(backupDir: string): Promise<void> {
  for (const directory of [backupDir, path.join(backupDir, "target")]) {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Invalid synchronization backup directory");
    }
    if ((await canonicalRoot(directory)) !== directory) {
      throw new Error("Invalid synchronization backup directory provenance");
    }
  }
}

export async function rollbackJournalSafely(
  targetRoot: string,
  journal: SyncJournal,
): Promise<void> {
  await assertRecoveryDirectoryIdentities(targetRoot, journal);
  const restorations: BackupRecord[] = [];
  for (const backup of journal.backups.filter((item) =>
    journal.mutatedPaths.includes(item.path),
  )) {
    let actual: SyncFile | null = null;
    try {
      actual = await describeSyncFile(targetRoot, backup.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const intended = journal.appliedStates[backup.path] ?? null;
    if (sameSyncFile(actual ?? undefined, intended ?? undefined)) {
      restorations.push(backup);
    } else if (
      !sameSyncFile(actual ?? undefined, backup.original ?? undefined)
    ) {
      throw new Error(
        `recovery conflict at ${backup.path}; divergent target preserved`,
      );
    }
  }
  await restoreBackups(targetRoot, restorations);
}

async function assertRecoveryDirectoryIdentities(
  targetRoot: string,
  journal: SyncJournal,
): Promise<void> {
  const conflict = (relative: string) =>
    `recovery conflict at ${relative}; divergent target directory preserved`;
  await assertDirectoryIdentities(
    targetRoot,
    journal.createdDirectories,
    conflict,
  );
  await assertDirectoryIdentities(
    targetRoot,
    journal.deleteParentDirectories,
    conflict,
  );
}
