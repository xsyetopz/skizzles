import { readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { PackagingError } from "./contract.ts";
import type { OwnedDirectory, RemovalHooks } from "./destination-artifacts.ts";
import {
  assertOwnedDirectory,
  quarantineOwnedDirectory,
  quarantineTransactionLock,
  readOwnedJson,
  writeOwnedJson,
} from "./destination-artifacts.ts";
import {
  JOURNAL_FILE,
  OWNER_FILE,
  parseJournal,
  temporaryName,
  UUID_PATTERN,
} from "./destination-journal.ts";
import type { TransactionTarget } from "./destination-path.ts";
import { disposalPath } from "./destination-path.ts";

interface LockRemovalHooks extends RemovalHooks {
  afterJournalRemoval?: () => Promise<void> | void;
  afterOwnerRemoval?: () => Promise<void> | void;
}

function lockEntryKind(name: string): "journal" | "owner" {
  if (name === JOURNAL_FILE) return "journal";
  if (name === OWNER_FILE) return "owner";
  for (const [kind, file] of [
    ["journal", JOURNAL_FILE],
    ["owner", OWNER_FILE],
  ] as const) {
    const prefix = `.${file}.`;
    if (name.startsWith(prefix) && name.endsWith(".tmp")) {
      const token = name.slice(prefix.length, -4);
      if (UUID_PATTERN.test(token) && name === temporaryName(file, token)) {
        return kind;
      }
    }
  }
  throw new PackagingError("Plugin staging lock contains unexpected entries.");
}

async function removeLock(
  lock: OwnedDirectory,
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
    kind: lockEntryKind(name),
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
  failure: unknown,
  hooks?: LockRemovalHooks,
): Promise<unknown> {
  if (lock === undefined || !lock.present) return failure;
  try {
    await removeLock(lock, hooks);
    return failure;
  } catch {
    return (
      failure ??
      new PackagingError("Plugin staging could not clean up its private lock.")
    );
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

export type { LockRemovalHooks };
export { cleanupOwnedLock, deferLockCleanup };
