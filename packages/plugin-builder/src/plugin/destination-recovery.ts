import { randomUUID } from "node:crypto";
import { chmod, readdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { PackagingError } from "./contract.ts";
import type { OwnedDirectory } from "./destination-artifacts.ts";
import {
  assertOwnedDirectory,
  cleanupOwned,
  inspectOwnedDirectory,
  quarantineTransactionLock,
  readOwnedJson,
  recoverableArtifact,
  writeOwnedJson,
} from "./destination-artifacts.ts";
import type { LockOwner, TransactionJournal } from "./destination-journal.ts";
import {
  deserialize,
  JOURNAL_FILE,
  matches,
  OWNER_FILE,
  parseJournal,
  parseOwner,
  temporaryName,
  UUID_PATTERN,
} from "./destination-journal.ts";
import { lockedDestinationError, lstatBigInt } from "./destination-parent.ts";
import type { TransactionTarget } from "./destination-path.ts";
import {
  assertPathIdentity,
  changedRecoveryDestinationError,
  inspectDestination,
  privateSiblingPath,
  transactionLockPath,
} from "./destination-path.ts";

const PROMOTED_DIRECTORY_MODE = 0o755;
const INCOMPLETE_LOCK_STALE_MS = 30_000;

class IncompleteRollbackError extends PackagingError {}

const ownerIsActive = (owner: LockOwner) =>
  processIdentity(owner.pid) === owner.processStartIdentity;

function processIdentity(pid: number): string | undefined {
  const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    env: { PATH: process.env["PATH"] ?? "", LC_ALL: "C" },
    stderr: "ignore",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return;
  const value = result.stdout.toString().trim();
  return value === "" ? undefined : value;
}

async function recoverStaleTransaction(target: TransactionTarget) {
  await recoverDeferredCleanup(target);
  const lock = await inspectOwnedDirectory(transactionLockPath(target));
  if (lock === undefined) return;
  let owner: LockOwner;
  try {
    owner = await readOwner(lock);
  } catch {
    await recoverUnknownLock(target, lock);
    return;
  }
  let journal: TransactionJournal;
  try {
    journal = await readJournal(lock, owner.token);
  } catch {
    const entries = await readdir(lock.path);
    if (
      ownerIsActive(owner) ||
      entries.includes(JOURNAL_FILE) ||
      entries.includes(temporaryName(JOURNAL_FILE, owner.token))
    ) {
      throw lockedDestinationError();
    }
    await recoverMissingJournal(target, lock, owner);
    return;
  }
  if (journal.state !== "cleanup-pending" && ownerIsActive(owner)) {
    throw lockedDestinationError();
  }
  await recoverJournal(target, lock, owner, journal);
}

async function recoverDeferredCleanup(target: TransactionTarget) {
  const prefix = `.skizzles-package-${target.key}-cleanup-`;
  for (const name of await readdir(target.parent)) {
    const token = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    if (!UUID_PATTERN.test(token)) continue;
    const lock = await inspectOwnedDirectory(join(target.parent, name));
    if (
      lock === undefined ||
      ((await lstatBigInt(lock.path)).mode & 0o777n) !== 0o700n
    ) {
      continue;
    }
    let owner: LockOwner;
    let journal: TransactionJournal;
    try {
      owner = await readOwner(lock);
      journal = await readJournal(lock, owner.token);
    } catch {
      continue;
    }
    if (owner.token === token && journal.state === "cleanup-pending") {
      await recoverJournal(target, lock, owner, journal);
    }
  }
}

async function recoverUnknownLock(
  target: TransactionTarget,
  lock: OwnedDirectory,
): Promise<void> {
  const age = BigInt(Date.now()) - (await lstatBigInt(lock.path)).mtimeMs;
  if (age < BigInt(INCOMPLETE_LOCK_STALE_MS)) throw lockedDestinationError();
  await assertOwnedDirectory(lock, "private destination lock");
  if ((await readdir(lock.path)).length === 0) {
    try {
      await rmdir(lock.path);
      lock.present = false;
      return;
    } catch {
      throw lockedDestinationError();
    }
  }
  if (
    !(await quarantineTransactionLock(target, lock, `unknown-${randomUUID()}`))
  ) {
    throw lockedDestinationError();
  }
}

async function recoverMissingJournal(
  target: TransactionTarget,
  lock: OwnedDirectory,
  owner: LockOwner,
): Promise<void> {
  const stage = await inspectOwnedDirectory(
    privateSiblingPath(target, "stage", owner.token),
  );
  const backup = await inspectOwnedDirectory(
    privateSiblingPath(target, "backup", owner.token),
  );
  if (stage !== undefined || backup !== undefined)
    throw lockedDestinationError();
  if (!(await quarantineTransactionLock(target, lock, owner.token))) {
    throw lockedDestinationError();
  }
}

async function recoverJournal(
  target: TransactionTarget,
  lock: OwnedDirectory,
  owner: LockOwner,
  journal: TransactionJournal,
): Promise<void> {
  if (
    journal.stage === undefined &&
    (journal.state !== "active" || journal.backup !== undefined)
  ) {
    throw lockedDestinationError();
  }
  const stage =
    journal.stage === undefined
      ? await inspectUnrecordedEmptyArtifact(target, "stage", owner.token)
      : await recoverableArtifact(target, "stage", owner.token, journal.stage);
  const backup =
    journal.backup === undefined
      ? await inspectUnrecordedEmptyArtifact(target, "backup", owner.token)
      : await recoverableArtifact(
          target,
          "backup",
          owner.token,
          journal.backup,
        );
  const destination = await inspectDestination(target.destination);
  if (matches(destination.identity, journal.stage)) {
    await chmod(target.destination, PROMOTED_DIRECTORY_MODE);
  } else if (
    journal.original.present &&
    !matches(destination.identity, journal.original.identity)
  ) {
    if (destination.present || backup === undefined) {
      throw changedRecoveryDestinationError();
    }
    await assertPathIdentity(
      join(backup.path, "previous"),
      deserialize(journal.original.identity),
    );
    await rename(join(backup.path, "previous"), target.destination);
  } else if (!journal.original.present && destination.present) {
    throw changedRecoveryDestinationError();
  }
  await cleanupOwned(stage, undefined);
  const backupFailure = await cleanupOwned(backup, undefined);
  if (backupFailure !== undefined) {
    if (!(await quarantineTransactionLock(target, lock, owner.token))) {
      throw lockedDestinationError();
    }
    return;
  }
  await cleanupOwned(lock, undefined);
}

async function readOwner(lock: OwnedDirectory): Promise<LockOwner> {
  const entries = await readdir(lock.path);
  if (entries.includes(OWNER_FILE)) {
    return parseOwner(await readOwnedJson(lock, OWNER_FILE));
  }
  const prefix = `.${OWNER_FILE}.`;
  const candidates = entries.filter(
    (name) => name.startsWith(prefix) && name.endsWith(".tmp"),
  );
  if (candidates.length !== 1) throw new Error("invalid owner publication");
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error("missing owner publication");
  const owner = parseOwner(await readOwnedJson(lock, candidate));
  if (candidate !== temporaryName(OWNER_FILE, owner.token)) {
    throw new Error("owner publication token mismatch");
  }
  return owner;
}

async function readJournal(
  lock: OwnedDirectory,
  token: string,
): Promise<TransactionJournal> {
  const temporary = temporaryName(JOURNAL_FILE, token);
  if ((await readdir(lock.path)).includes(temporary)) {
    try {
      return parseJournal(await readOwnedJson(lock, temporary));
    } catch {}
  }
  return parseJournal(await readOwnedJson(lock, JOURNAL_FILE));
}

async function inspectUnrecordedEmptyArtifact(
  target: TransactionTarget,
  kind: "backup" | "stage",
  token: string,
): Promise<OwnedDirectory | undefined> {
  const artifact = await inspectOwnedDirectory(
    privateSiblingPath(target, kind, token),
  );
  if (
    artifact !== undefined &&
    ((await readdir(artifact.path)).length > 0 ||
      ((await lstatBigInt(artifact.path)).mode & 0o777n) !== 0o700n)
  ) {
    throw lockedDestinationError();
  }
  return artifact;
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

export {
  IncompleteRollbackError,
  PROMOTED_DIRECTORY_MODE,
  preserveIncompleteRollback,
  processIdentity,
  readJournal,
  recoverStaleTransaction,
};
