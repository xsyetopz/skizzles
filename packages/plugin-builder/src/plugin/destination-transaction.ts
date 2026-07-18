import { randomUUID } from "node:crypto";
import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { PackagingError } from "./contract.ts";
import type { OwnedDirectory } from "./destination-artifacts.ts";
import {
  acquireLock,
  assertOwnedDirectory,
  cleanupOwned,
  createPrivateSibling,
  quarantineTransactionLock,
  removeOwnedDirectory,
  writeOwnedJson,
} from "./destination-artifacts.ts";
import type { LockOwner, TransactionJournal } from "./destination-parent.ts";
import {
  cleanupOwnedParents,
  ensureDestinationParent,
  serialized,
} from "./destination-parent.ts";
import type {
  DestinationSnapshot,
  TransactionTarget,
} from "./destination-path.ts";
import {
  assertDestinationUnchanged,
  assertPathAbsent,
  assertPathIdentity,
  changedDestinationError,
  initialJournal,
  inspectDestination,
  inspectTarget,
  revalidateAncestors,
} from "./destination-path.ts";
import {
  IncompleteRollbackError,
  JOURNAL_FILE,
  OWNER_FILE,
  PROMOTED_DIRECTORY_MODE,
  PROTOCOL_VERSION,
  processIdentity,
  readJournal,
  recoverStaleTransaction,
  rollbackOwnedPromotion,
} from "./destination-recovery.ts";

interface DestinationTransactionHooks {
  afterParentCreated?: (path: string) => Promise<void> | void;
  beforeBackupCleanup?: (path: string) => Promise<void> | void;
  beforeLockCleanup?: (path: string) => Promise<void> | void;
  beforeLockRemovalRename?: () => Promise<void> | void;
  checkpoint?: (checkpoint: Checkpoint) => Promise<void> | void;
}

function currentOwner(): LockOwner {
  const processStartIdentity = processIdentity(process.pid);
  if (processStartIdentity === undefined) {
    throw new PackagingError("Plugin staging could not identify lock owner.");
  }
  return {
    version: PROTOCOL_VERSION,
    pid: process.pid,
    processStartIdentity,
    token: randomUUID(),
  };
}

type Checkpoint =
  | "owner-ready"
  | "initial-journal-ready"
  | "stage-journal-ready"
  | "backup-journal-ready"
  | "backup-ready"
  | "backup-validated"
  | "backup-renamed"
  | "destination-ready"
  | "destination-renamed"
  | "committed-journal-ready"
  | "committed";

async function replaceDirectoryTransaction(
  destinationInput: string,
  construct: (privateRoot: string) => Promise<void>,
  hooks: DestinationTransactionHooks = {},
): Promise<void> {
  const parents = await ensureDestinationParent(
    destinationInput,
    hooks.afterParentCreated,
  );
  let committed = false;
  try {
    const target = await inspectTarget(destinationInput);
    await recoverStaleTransaction(target);
    const lock = await acquireLock(target);
    let stage: OwnedDirectory | undefined;
    try {
      const owner = currentOwner();
      await writeOwnedJson(lock, OWNER_FILE, owner, owner.token, () =>
        hooks.checkpoint?.("owner-ready"),
      );
      const original = await inspectDestination(target.destination);
      const journal = initialJournal(original, PROTOCOL_VERSION);
      await writeOwnedJson(lock, JOURNAL_FILE, journal, owner.token, () =>
        hooks.checkpoint?.("initial-journal-ready"),
      );
      stage = await createPrivateSibling(target, "stage", owner.token);
      journal.stage = serialized(stage.identity);
      await writeOwnedJson(lock, JOURNAL_FILE, journal, owner.token, () =>
        hooks.checkpoint?.("stage-journal-ready"),
      );
      await construct(stage.path);
      await assertOwnedDirectory(lock, "private destination lock");
      await assertOwnedDirectory(stage, "private construction directory");
      await revalidateAncestors(target.ancestors);
      await assertDestinationUnchanged(target.destination, original);
      const backup = await promote(
        target,
        original,
        stage,
        lock,
        owner,
        journal,
        hooks,
      );
      committed = true;
      await finishCommitted(target, lock, owner, backup, hooks).catch(
        () => undefined,
      );
    } catch (error) {
      if (error instanceof IncompleteRollbackError) throw error;
      let failure = await cleanupOwned(stage, error);
      failure = await cleanupOwned(lock, failure);
      throw failure;
    }
  } finally {
    if (!committed) {
      await cleanupOwnedParents(parents);
    }
  }
}

async function promote(
  target: TransactionTarget,
  original: DestinationSnapshot,
  stage: OwnedDirectory,
  lock: OwnedDirectory,
  owner: LockOwner,
  inputJournal: TransactionJournal,
  hooks: DestinationTransactionHooks,
): Promise<OwnedDirectory | undefined> {
  let backup: OwnedDirectory | undefined;
  const journal = inputJournal;
  let previousMoved = false;
  let stageMoved = false;
  let commitReached = false;
  try {
    if (original.present) {
      backup = await createPrivateSibling(target, "backup", owner.token);
      journal.backup = serialized(backup.identity);
      await writeOwnedJson(lock, JOURNAL_FILE, journal, owner.token, () =>
        hooks.checkpoint?.("backup-journal-ready"),
      );
      await hooks.checkpoint?.("backup-ready");
      await assertDestinationUnchanged(target.destination, original);
      await hooks.checkpoint?.("backup-validated");
      await rename(target.destination, join(backup.path, "previous"));
      previousMoved = true;
      try {
        await assertPathIdentity(
          join(backup.path, "previous"),
          original.identity,
        );
      } catch (error) {
        try {
          await assertPathAbsent(target.destination);
          await rename(join(backup.path, "previous"), target.destination);
          previousMoved = false;
        } catch {
          // The recovery journal retains both paths when restoration races.
        }
        throw changedDestinationError();
      }
      await hooks.checkpoint?.("backup-renamed");
    }

    // Node/Bun exposes no portable directory-exchange primitive. Existing
    // destinations are briefly absent between these two same-filesystem
    // renames; the journal makes every crash point deterministically recoverable.
    // For an initially absent destination, Node/Bun also lacks a portable
    // rename-no-replace primitive, so a hostile empty-directory insertion in
    // the final syscall race cannot be distinguished after promotion.
    await hooks.checkpoint?.("destination-ready");
    if (original.present) {
      await assertPathAbsent(target.destination);
    } else {
      await assertDestinationUnchanged(target.destination, original);
    }
    await rename(stage.path, target.destination);
    stage.present = false;
    stageMoved = true;
    await hooks.checkpoint?.("destination-renamed");
    await chmod(target.destination, PROMOTED_DIRECTORY_MODE);
    await assertPathIdentity(target.destination, stage.identity);
    journal.state = "committed";
    await writeOwnedJson(lock, JOURNAL_FILE, journal, owner.token, () =>
      hooks.checkpoint?.("committed-journal-ready"),
    );
    commitReached = true;
    await hooks.checkpoint?.("committed");
    return backup;
  } catch (error) {
    if (commitReached) return backup;
    try {
      await rollbackOwnedPromotion({
        backup,
        original,
        previousMoved,
        stage,
        stageMoved,
        target,
      });
    } catch (rollbackError) {
      throw await preserveIncompleteRollback(
        lock,
        owner,
        journal,
        rollbackError,
      );
    }
    throw error instanceof PackagingError
      ? error
      : new PackagingError(
          original.present
            ? "Plugin staging promotion failed; the previous destination was restored."
            : "Plugin staging promotion failed; the destination remains absent.",
        );
  }
}

async function finishCommitted(
  target: TransactionTarget,
  lock: OwnedDirectory,
  owner: LockOwner,
  backup: OwnedDirectory | undefined,
  hooks: DestinationTransactionHooks,
): Promise<void> {
  if (backup !== undefined) {
    try {
      await hooks.beforeBackupCleanup?.(backup.path);
      await removeOwnedDirectory(backup);
    } catch {
      await writeOwnedJson(
        lock,
        JOURNAL_FILE,
        { ...(await readJournal(lock, owner.token)), state: "cleanup-pending" },
        owner.token,
      ).catch(() => undefined);
      await quarantineTransactionLock(target, lock, owner.token);
      return;
    }
  }
  await hooks.beforeLockCleanup?.(lock.path);
  await cleanupOwned(lock, undefined, hooks.beforeLockRemovalRename);
}

async function preserveIncompleteRollback(
  lock: OwnedDirectory,
  owner: LockOwner,
  journal: TransactionJournal,
  cause: unknown,
): Promise<IncompleteRollbackError> {
  journal.state = "cleanup-pending";
  await writeOwnedJson(lock, JOURNAL_FILE, journal, owner.token).catch(
    () => undefined,
  );
  return new IncompleteRollbackError(
    "Plugin staging promotion failed and rollback could not complete safely.",
    { cause },
  );
}

export { replaceDirectoryTransaction };
