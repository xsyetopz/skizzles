import { chmod, readdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { PackagingError } from "./contract.ts";
import type { OwnedDirectory } from "./destination-artifacts.ts";
import {
  assertOwnedDirectory,
  cleanupOwned,
  inspectOwnedVariant,
  quarantineTransactionLock,
  readOwnedJson,
} from "./destination-artifacts.ts";
import type { LockOwner, TransactionJournal } from "./destination-journal.ts";
import {
  deserialize,
  JOURNAL_FILE,
  matches,
  OWNER_FILE,
  ownerIsActive,
  parseJournal,
  parseOwner,
  temporaryName,
  UUID_PATTERN,
} from "./destination-journal.ts";
import {
  cleanupOwnedLock,
  deferLockCleanup,
} from "./destination-lock-disposal.ts";
import { lockedDestinationError, lstatBigInt } from "./destination-parent.ts";
import type { TransactionTarget } from "./destination-path.ts";
import {
  assertPathIdentity,
  changedRecoveryDestinationError,
  inspectDestination,
  privateSiblingPath,
  transactionLockPath,
} from "./destination-path.ts";

export const PROMOTED_DIRECTORY_MODE = 0o755;

export async function recoverStaleTransaction(target: TransactionTarget) {
  await recoverDeferredCleanup(target);
  const lock = await inspectOwnedVariant(transactionLockPath(target));
  if (lock === undefined) return;
  let owner: LockOwner;
  try {
    owner = await readOwner(lock);
  } catch {
    await recoverUnknownLock(lock);
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
  if (ownerIsActive(owner)) throw lockedDestinationError();
  await recoverJournal(target, lock, owner, journal);
}

async function recoverDeferredCleanup(target: TransactionTarget) {
  const prefix = `.skizzles-package-${target.key}-cleanup-`;
  const candidates = (await readdir(target.parent))
    .filter((name) => name.startsWith(prefix))
    .sort();
  if (candidates.length === 0) return;
  if (candidates.length !== 1) throw lockedDestinationError();
  const candidate = candidates[0];
  if (candidate === undefined) throw lockedDestinationError();
  const suffix = candidate.slice(prefix.length);
  const disposed = suffix.endsWith(".dispose");
  const token = disposed ? suffix.slice(0, -8) : suffix;
  if (!UUID_PATTERN.test(token)) throw lockedDestinationError();
  const canonical = join(target.parent, `${prefix}${token}`);
  const lock = await inspectOwnedVariant(canonical);
  if (
    lock === undefined ||
    ((await lstatBigInt(lock.path)).mode & 0o777n) !== 0o700n
  ) {
    throw lockedDestinationError();
  }
  let owner: LockOwner;
  try {
    owner = await readOwner(lock);
  } catch {
    if (disposed && (await readdir(lock.path)).length === 0) {
      await requireLockCleanup(lock, token);
      return;
    }
    throw lockedDestinationError();
  }
  if (owner.token !== token || ownerIsActive(owner)) {
    throw lockedDestinationError();
  }
  let journal: TransactionJournal;
  try {
    journal = await readJournal(lock, token);
  } catch {
    if (!(await transactionArtifactsRemain(target, token))) {
      await requireLockCleanup(lock, token);
      return;
    }
    throw lockedDestinationError();
  }
  if (journal.state !== "cleanup-pending") throw lockedDestinationError();
  await recoverJournal(target, lock, owner, journal);
}

async function recoverUnknownLock(lock: OwnedDirectory): Promise<void> {
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
  throw lockedDestinationError();
}

async function recoverMissingJournal(
  target: TransactionTarget,
  lock: OwnedDirectory,
  owner: LockOwner,
): Promise<void> {
  if (await transactionArtifactsRemain(target, owner.token))
    throw lockedDestinationError();
  if (!(await quarantineTransactionLock(target, lock, owner.token))) {
    throw lockedDestinationError();
  }
  await requireLockCleanup(lock, owner.token);
}

export async function transactionArtifactsRemain(
  target: TransactionTarget,
  token: string,
) {
  const stage = inspectOwnedVariant(privateSiblingPath(target, "stage", token));
  const backup = inspectOwnedVariant(
    privateSiblingPath(target, "backup", token),
  );
  return (await stage) !== undefined || (await backup) !== undefined;
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
  const stageCleanup = await cleanupOwned(stage, undefined);
  const backupCleanup = await cleanupOwned(backup, undefined);
  if (!stageCleanup.removed || !backupCleanup.removed) {
    await deferLockCleanup(target, lock, owner.token);
    throw stageCleanup.removed ? backupCleanup.failure : stageCleanup.failure;
  }
  await requireLockCleanup(lock, owner.token);
}

async function requireLockCleanup(
  lock: OwnedDirectory,
  token: string,
): Promise<void> {
  const outcome = await cleanupOwnedLock(lock, token, undefined);
  if (!outcome.removed) throw outcome.failure;
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

export async function readJournal(
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
  const artifact = await inspectOwnedVariant(
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

async function recoverableArtifact(
  target: TransactionTarget,
  kind: "backup" | "stage",
  token: string,
  expected: TransactionJournal["stage"],
): Promise<OwnedDirectory | undefined> {
  const artifact = await inspectOwnedVariant(
    privateSiblingPath(target, kind, token),
  );
  if (artifact !== undefined && !matches(artifact.identity, expected)) {
    throw new PackagingError(
      "Plugin staging recovery artifact identity changed.",
    );
  }
  return artifact;
}
