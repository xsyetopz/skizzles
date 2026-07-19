import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { PackagingError } from "./contract.ts";
import type { OwnedDirectory } from "./destination-artifacts.ts";
import {
  acquireLock,
  assertOwnedDirectory,
  cleanupOwned,
  createPrivateSibling,
  removeOwnedDirectory,
  writeOwnedJson,
} from "./destination-artifacts.ts";
import {
  acquireClaim,
  retireClaim,
  transactionArtifactsRemain,
} from "./destination-claim.ts";
import type { LockOwner, TransactionJournal } from "./destination-journal.ts";
import { JOURNAL_FILE, OWNER_FILE, serialized } from "./destination-journal.ts";
import {
  cleanupOwnedLock,
  deferLockCleanup,
  IncompleteRollbackError,
  preserveIncompleteRollback,
} from "./destination-lock-disposal.ts";
import {
  cleanupOwnedParents,
  ensureDestinationParent,
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
import { rollbackOwnedPromotion } from "./destination-promotion-rollback.ts";
import {
  PROMOTED_DIRECTORY_MODE,
  recoverStaleTransaction,
} from "./destination-recovery.ts";
import type { DestinationTransactionHooks } from "./destination-transaction-hooks.ts";

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
    await recoverStaleTransaction(target, hooks.checkpoint);
    const claim = await acquireClaim(target, hooks.checkpoint);
    let removeClaim = true;
    let lock: OwnedDirectory | undefined;
    let stage: OwnedDirectory | undefined;
    let journal: TransactionJournal | undefined;
    try {
      lock = await acquireLock(target);
      removeClaim = false;
      const owner = claim.owner;
      await hooks.checkpoint?.("lock-created", lock.path);
      await writeOwnedJson(lock, OWNER_FILE, owner, owner.token, () =>
        hooks.checkpoint?.("owner-ready"),
      );
      const original = await inspectDestination(target.destination);
      journal = initialJournal(original);
      await writeOwnedJson(lock, JOURNAL_FILE, journal, owner.token, () =>
        hooks.checkpoint?.("initial-journal-ready"),
      );
      stage = await createPrivateSibling(target, "stage", owner.token);
      await hooks.checkpoint?.("stage-created");
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
      removeClaim = await finishCommitted(
        target,
        lock,
        owner,
        backup,
        hooks,
      ).catch(() => false);
    } catch (error) {
      if (error instanceof IncompleteRollbackError) throw error;
      const owner = claim.owner;
      const stageCleanup = await cleanupOwned(stage, error, {
        afterRename: (path) =>
          hooks.checkpoint?.("stage-disposal-renamed", path),
        beforeRemove: (path) =>
          hooks.checkpoint?.("stage-disposal-remove", path),
      });
      const artifactsRemain = await transactionArtifactsRemain(
        target,
        owner.token,
      ).catch(() => true);
      if (
        (!stageCleanup.removed || artifactsRemain) &&
        journal !== undefined &&
        lock !== undefined
      ) {
        await deferLockCleanup(target, lock, owner.token);
        throw stageCleanup.failure;
      }
      const lockCleanup = await cleanupOwnedLock(
        lock,
        owner.token,
        stageCleanup.failure,
      );
      removeClaim = lockCleanup.removed;
      throw lockCleanup.failure;
    } finally {
      await retireClaim(claim, removeClaim, hooks.checkpoint).catch(
        () => undefined,
      );
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
  journal: TransactionJournal,
  hooks: DestinationTransactionHooks,
): Promise<OwnedDirectory | undefined> {
  let backup: OwnedDirectory | undefined;
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
        } catch {}
        throw changedDestinationError();
      }
      await hooks.checkpoint?.("backup-renamed");
    }

    // Node/Bun has no portable directory exchange: existing destinations are
    // briefly absent, but the journal makes each crash point recoverable.
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
): Promise<boolean> {
  if (backup !== undefined) {
    try {
      await hooks.beforeBackupCleanup?.(backup.path);
      await removeOwnedDirectory(backup, {
        beforeRename: () =>
          hooks.checkpoint?.("backup-disposal-ready", backup.path),
        afterRename: (path) =>
          hooks.checkpoint?.("backup-disposal-renamed", path),
        beforeRemove: (path) =>
          hooks.checkpoint?.("backup-disposal-remove", path),
      });
    } catch {
      await deferLockCleanup(target, lock, owner.token);
      return false;
    }
  }
  await hooks.beforeLockCleanup?.(lock.path);
  const cleanup = await cleanupOwnedLock(lock, owner.token, undefined, {
    beforeRename: async () => {
      await hooks.checkpoint?.("lock-disposal-ready", lock.path);
      await hooks.beforeLockRemovalRename?.();
    },
    afterRename: (path) => hooks.checkpoint?.("lock-disposal-renamed", path),
    beforeRemove: (path) => hooks.checkpoint?.("lock-disposal-remove", path),
    afterJournalRemoval: () => hooks.checkpoint?.("lock-disposal-journal"),
    afterOwnerRemoval: () => hooks.checkpoint?.("lock-disposal-owner"),
  });
  return cleanup.removed;
}

export { replaceDirectoryTransaction };
