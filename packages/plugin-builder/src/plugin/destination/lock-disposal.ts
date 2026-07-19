import { readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { PackagingError } from "../contract.ts";
import type {
  CleanupOutcome,
  OwnedDirectory,
  RemovalHooks,
} from "./artifacts.ts";
import {
  assertOwnedDirectory,
  quarantineOwnedDirectory,
  quarantineTransactionLock,
  readOwnedJson,
  writeOwnedJson,
} from "./artifacts.ts";
import {
  JOURNAL_FILE,
  type LockOwner,
  OWNER_FILE,
  parseJournal,
  type TransactionJournal,
  temporaryName,
} from "./journal.ts";
import type { TransactionTarget } from "./path.ts";
import { disposalPath } from "./path.ts";

interface LockRemovalHooks extends RemovalHooks {
  afterJournalRemoval?: () => Promise<void> | void;
  afterOwnerRemoval?: () => Promise<void> | void;
}

class IncompleteRollbackError extends PackagingError {}

function lockEntryKind(name: string, token: string): "journal" | "owner" {
  if (name === JOURNAL_FILE) return "journal";
  if (name === OWNER_FILE) return "owner";
  for (const [kind, file] of [
    ["journal", JOURNAL_FILE],
    ["owner", OWNER_FILE],
  ] as const) {
    const prefix = `.${file}.`;
    if (
      name.startsWith(prefix) &&
      name.endsWith(".tmp") &&
      name === temporaryName(file, token)
    ) {
      return kind;
    }
  }
  throw new PackagingError("Plugin staging lock contains unexpected entries.");
}

async function removeLock(
  lock: OwnedDirectory,
  token: string,
  hooks: LockRemovalHooks = {},
): Promise<void> {
  if (!lock.present) return;
  if (!lock.path.endsWith(".dispose")) {
    await quarantineOwnedDirectory(
      lock,
      disposalPath(lock.path),
      hooks.beforeRename,
    );
    await hooks.afterRename?.(lock.path);
  }
  await hooks.beforeRemove?.(lock.path);
  await assertOwnedDirectory(lock, "private destination lock");
  const entries = (await readdir(lock.path)).map((name) => ({
    kind: lockEntryKind(name, token),
    name,
  }));
  for (const { kind, name } of entries) {
    if (kind === "journal") await rm(join(lock.path, name), { force: true });
  }
  await hooks.afterJournalRemoval?.();
  for (const { kind, name } of entries) {
    if (kind === "owner") await rm(join(lock.path, name), { force: true });
  }
  await hooks.afterOwnerRemoval?.();
  await assertOwnedDirectory(lock, "private destination lock");
  await rmdir(lock.path);
  lock.present = false;
}

async function cleanupOwnedLock(
  lock: OwnedDirectory | undefined,
  token: string,
  failure: unknown,
  hooks?: LockRemovalHooks,
): Promise<CleanupOutcome> {
  if (lock === undefined || !lock.present) return { failure, removed: true };
  try {
    await removeLock(lock, token, hooks);
    return { failure, removed: true };
  } catch {
    return {
      failure:
        failure ??
        new PackagingError(
          "Plugin staging could not clean up its private lock.",
        ),
      removed: false,
    };
  }
}

async function deferLockCleanup(
  target: TransactionTarget,
  lock: OwnedDirectory,
  token: string,
): Promise<void> {
  try {
    const journal = parseJournal(await readOwnedJson(lock, JOURNAL_FILE));
    journal.state = "cleanup-pending";
    await writeOwnedJson(lock, JOURNAL_FILE, journal, token);
  } catch {
    return;
  }
  await quarantineTransactionLock(target, lock, token);
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

export type { LockRemovalHooks };
export {
  cleanupOwnedLock,
  deferLockCleanup,
  IncompleteRollbackError,
  preserveIncompleteRollback,
};
