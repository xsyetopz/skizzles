import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { safeStateName } from "../files.ts";
import { compareManifests } from "./comparison.ts";
import type {
  ApplySyncOptions,
  BaselineFile,
  StoredPreview,
  SyncJournal,
} from "./contract.ts";
import { syncDirectory, writeDurableJson } from "./durability.ts";
import {
  buildGitManifest,
  type GitManifest,
  manifestDigest,
} from "./git-manifest.ts";
import {
  assertPreviewBinding,
  canonicalPreviewRoots,
  previewBinding,
} from "./preview.ts";
import { rollbackJournalSafely } from "./recovery.ts";
import {
  applyChange,
  assertDirectoryIdentities,
  assertExpectedEntry,
  backupTargets,
  captureDeleteParentDirectories,
  cleanupCreatedDirectories,
  cleanupPublications,
  createPlannedDirectories,
  planBackupRecords,
  planCreatedDirectories,
  stageSources,
  validateBackupArtifacts,
} from "./staging.ts";
import {
  readRequiredUnknownJson,
  type SyncStatePaths,
  syncStatePaths,
} from "./state.ts";
import { parseBaselineFile, parseStoredPreview } from "./validation/preview.ts";

interface ValidatedSync {
  sourceRoot: string;
  targetRoot: string;
  source: GitManifest;
}

interface PreparedTransaction extends ValidatedSync {
  backupDir: string;
  stagedRoot: string;
  journalPath: string;
  journal: SyncJournal;
}

export interface SyncTransactionHooks {
  beforePathPublished?: (relative: string) => void | Promise<void>;
  afterDirectoryCreated?: (relative: string) => void | Promise<void>;
  afterPathPublished?: (relative: string) => void | Promise<void>;
  afterJournalApplied?: () => void | Promise<void>;
  afterBaselinePublished?: () => void | Promise<void>;
}

export async function applySync(
  options: ApplySyncOptions,
): Promise<{ applied: number }> {
  return await applySyncWithHooks(options);
}

export async function applySyncWithHooks(
  options: ApplySyncOptions,
  hooks: SyncTransactionHooks = {},
): Promise<{ applied: number }> {
  const state = await syncStatePaths(options);
  const previewPath = path.join(
    state.previews,
    `${safeStateName(options.token, "preview token")}.json`,
  );
  const preview = parseStoredPreview(
    await readRequiredUnknownJson(
      previewPath,
      "Unknown or already-used synchronization preview token",
    ),
  );
  const validated = await validatePreview(options, preview, state);
  await claimPreview(state, previewPath, options.token);
  const transaction = await prepareTransaction(state, preview, validated);
  return await executeTransaction(options, preview, transaction, hooks);
}

async function validatePreview(
  options: ApplySyncOptions,
  preview: StoredPreview,
  state: SyncStatePaths,
): Promise<ValidatedSync> {
  const { sourceRoot, targetRoot } = await canonicalPreviewRoots(options);
  assertPreviewBinding(preview, options, sourceRoot, targetRoot);
  if (preview.binding !== previewBinding(preview)) {
    throw new Error("Synchronization preview binding is invalid");
  }
  if ((options.now ?? new Date()).getTime() >= Date.parse(preview.expiresAt)) {
    throw new Error("Synchronization preview token has expired");
  }
  if (preview.conflicts.length > 0) {
    throw new Error("Synchronization preview contains conflicts");
  }

  const [source, target, baselineValue] = await Promise.all([
    buildGitManifest(sourceRoot),
    buildGitManifest(targetRoot),
    readRequiredUnknownJson(
      state.baseline,
      "Synchronization baseline is missing; initialize it when the lab is created",
    ),
  ]);
  const baseline = parseBaselineFile(baselineValue);
  if (
    source.digest !== preview.sourceDigest ||
    target.digest !== preview.targetDigest
  ) {
    throw new Error(
      "Synchronization preview is stale; source or target changed",
    );
  }
  const deleteParentDirectories = await captureDeleteParentDirectories(
    targetRoot,
    preview.changes,
  );
  if (
    JSON.stringify(deleteParentDirectories) !==
    JSON.stringify(preview.deleteParentDirectories)
  ) {
    throw new Error(
      "Synchronization preview is stale; target parent directories changed",
    );
  }
  assertPreviewSemantics(preview, baseline, source, target);
  const missingTargetDirectories = await planCreatedDirectories(
    targetRoot,
    preview.changes,
  );
  if (
    JSON.stringify(missingTargetDirectories) !==
    JSON.stringify(preview.missingTargetDirectories)
  ) {
    throw new Error(
      "Synchronization preview is stale; target directories changed",
    );
  }
  const idle = await options.idleGuard();
  if (idle === false) {
    throw new Error("Synchronization apply requires an idle lab");
  }
  return { sourceRoot, targetRoot, source };
}

async function claimPreview(
  state: SyncStatePaths,
  previewPath: string,
  token: string,
): Promise<void> {
  // Rename is the single-use claim and is atomic against concurrent applies.
  const claimed = path.join(state.used, `${token}.json`);
  await rename(previewPath, claimed).catch(() => {
    throw new Error("Unknown or already-used synchronization preview token");
  });
  await Promise.all([
    syncDirectory(path.dirname(previewPath)),
    syncDirectory(path.dirname(claimed)),
  ]);
}

async function prepareTransaction(
  state: SyncStatePaths,
  preview: StoredPreview,
  validated: ValidatedSync,
): Promise<PreparedTransaction> {
  const journalId = randomUUID();
  const backupDir = path.join(state.backups, journalId);
  const journalPath = path.join(state.journals, `${journalId}.json`);
  const stagedRoot = path.join(backupDir, "source");
  const targetBackups = path.join(backupDir, "target");
  const backups = await planBackupRecords(
    validated.targetRoot,
    preview.changes,
    preview.expectedTargets,
    targetBackups,
    journalId,
  );
  const journal: SyncJournal = {
    version: 1,
    state: "preparing",
    previewToken: preview.token,
    previewBinding: preview.binding,
    targetRoot: validated.targetRoot,
    baselinePath: state.baseline,
    newBaseline: { version: 1, files: validated.source.files },
    backups,
    createdDirectories: [],
    deleteParentDirectories: preview.deleteParentDirectories,
    mutatedPaths: [],
    appliedStates: Object.fromEntries(
      preview.changes.map((change) => [change.path, change.file ?? null]),
    ),
  };
  try {
    await writeDurableJson(journalPath, journal);
    await mkdir(stagedRoot, { recursive: true });
    await stageSources(validated.sourceRoot, preview.changes, stagedRoot);
    await mkdir(targetBackups);
    await backupTargets(validated.targetRoot, backups);
    await validateBackupArtifacts(backups);
    await Promise.all([
      syncDirectory(targetBackups),
      syncDirectory(backupDir),
      syncDirectory(state.backups),
    ]);
    journal.state = "prepared";
    await writeDurableJson(journalPath, journal);
  } catch (error) {
    try {
      await rm(backupDir, { recursive: true, force: true });
      await rm(journalPath, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `Synchronization preparation failed and recovery state was retained: ${
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        }`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    ...validated,
    backupDir,
    stagedRoot,
    journalPath,
    journal,
  };
}

async function executeTransaction(
  options: ApplySyncOptions,
  preview: StoredPreview,
  transaction: PreparedTransaction,
  hooks: SyncTransactionHooks,
): Promise<{ applied: number }> {
  const {
    backupDir,
    journal,
    journalPath,
    sourceRoot,
    stagedRoot,
    targetRoot,
  } = transaction;
  let appliedJournalPublished = false;
  try {
    await verifyFreshPreview(preview, sourceRoot, targetRoot);
    const idleImmediatelyBeforeMutation = await options.idleGuard();
    if (idleImmediatelyBeforeMutation === false) {
      throw new Error("Synchronization apply requires an idle lab");
    }
    await assertDirectoryIdentities(
      targetRoot,
      journal.deleteParentDirectories,
      (relative) =>
        `Synchronization target parent changed after preview: ${relative}`,
    );
    await assertExpectedTargets(targetRoot, preview);
    await createPlannedDirectories(
      targetRoot,
      preview.missingTargetDirectories,
      async (identity) => {
        journal.createdDirectories.push(identity);
        delete journal.creatingDirectory;
        await writeDurableJson(journalPath, journal);
      },
      async (relative) => {
        journal.creatingDirectory = relative;
        await writeDurableJson(journalPath, journal);
      },
      (relative) => hooks.afterDirectoryCreated?.(relative),
    );
    for (const [index, change] of preview.changes.entries()) {
      const backup = journal.backups[index];
      if (!backup) {
        throw new Error(`Missing synchronization backup for ${change.path}`);
      }
      await assertExpectedEntry(
        targetRoot,
        change.path,
        preview.expectedTargets[change.path] ?? null,
        "target",
      );
      journal.mutatedPaths.push(change.path);
      await writeDurableJson(journalPath, journal);
      await applyChange(stagedRoot, targetRoot, change, backup, () =>
        hooks.beforePathPublished?.(change.path),
      );
      await hooks.afterPathPublished?.(change.path);
    }
    journal.state = "applied";
    await writeDurableJson(journalPath, journal);
    appliedJournalPublished = true;
    await hooks.afterJournalApplied?.();
    await writeDurableJson(journal.baselinePath, journal.newBaseline);
    await hooks.afterBaselinePublished?.();
    await cleanupPublications(journal.backups);
    journal.state = "committed";
    await writeDurableJson(journalPath, journal);
    await rm(backupDir, { recursive: true, force: true });
    await rm(journalPath, { force: true });
    return { applied: preview.changes.length };
  } catch (error) {
    if (appliedJournalPublished) {
      throw new Error(
        "Synchronization targets were applied and recovery state was retained for baseline publication",
        { cause: error },
      );
    }
    try {
      await resolveCreatingDirectory(targetRoot, journal, journalPath);
      await assertDirectoryIdentities(
        targetRoot,
        journal.createdDirectories,
        (relative) =>
          `recovery conflict at ${relative}; divergent target directory preserved`,
      );
      await assertDirectoryIdentities(
        targetRoot,
        journal.deleteParentDirectories,
        (relative) =>
          `recovery conflict at ${relative}; divergent target directory preserved`,
      );
      await rollbackJournalSafely(targetRoot, journal);
      await cleanupPublications(
        journal.backups.filter((backup) =>
          journal.mutatedPaths.includes(backup.path),
        ),
      );
      if (journal.createdDirectories.length > 0) {
        await cleanupCreatedDirectories(targetRoot, journal.createdDirectories);
      }
      journal.createdDirectories = [];
      journal.state = "rolledBack";
      await writeDurableJson(journalPath, journal);
      await rm(backupDir, { recursive: true, force: true });
      await rm(journalPath, { force: true });
    } catch (rollbackError) {
      throw new Error(
        `Synchronization apply failed and recovery state was retained: ${
          rollbackError instanceof Error ? rollbackError.message : rollbackError
        }`,
        { cause: error },
      );
    }
    throw error;
  }
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

function assertPreviewSemantics(
  preview: StoredPreview,
  baseline: BaselineFile,
  source: GitManifest,
  target: GitManifest,
): void {
  if (manifestDigest(baseline.files) !== preview.baselineDigest) {
    throw new Error("Synchronization preview is stale; baseline changed");
  }
  const comparison = compareManifests(
    baseline.files,
    source.files,
    target.files,
  );
  const expectedTargets = Object.fromEntries(
    comparison.changes.map((change) => [
      change.path,
      target.files[change.path] ?? null,
    ]),
  );
  if (
    JSON.stringify(comparison.changes) !== JSON.stringify(preview.changes) ||
    JSON.stringify(comparison.conflicts) !==
      JSON.stringify(preview.conflicts) ||
    JSON.stringify(expectedTargets) !== JSON.stringify(preview.expectedTargets)
  ) {
    throw new Error("Synchronization preview semantic payload is invalid");
  }
}

async function verifyFreshPreview(
  preview: StoredPreview,
  sourceRoot: string,
  targetRoot: string,
): Promise<void> {
  const [freshSource, freshTarget] = await Promise.all([
    buildGitManifest(sourceRoot),
    buildGitManifest(targetRoot),
  ]);
  if (
    freshSource.digest !== preview.sourceDigest ||
    freshTarget.digest !== preview.targetDigest
  ) {
    throw new Error("Synchronization preview became stale before mutation");
  }
}

async function assertExpectedTargets(
  targetRoot: string,
  preview: StoredPreview,
): Promise<void> {
  for (const change of preview.changes) {
    await assertExpectedEntry(
      targetRoot,
      change.path,
      preview.expectedTargets[change.path] ?? null,
      "target",
    );
  }
}
