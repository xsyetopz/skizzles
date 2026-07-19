import { chmod, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { PackagingError } from "../contract.ts";
import type { OwnedDirectory } from "./artifacts.ts";
import {
  cleanupOwned,
  inspectOwnedVariant,
  quarantineTransactionLock,
  readOwnedJson,
} from "./artifacts.ts";
import type { ClaimCheckpoint } from "./claim.ts";
import {
  hasUnclaimedLockNamespace,
  inspectClaim,
  recoverClaimTemps,
  recoverUnknownClaimLock,
  sameOwner,
  transactionArtifactsRemain,
} from "./claim.ts";
import type { LockOwner, TransactionJournal } from "./journal.ts";
import {
  deserialize,
  JOURNAL_FILE,
  matches,
  OWNER_FILE,
  parseJournal,
  parseOwner,
  temporaryName,
  UUID_PATTERN,
} from "./journal.ts";
import { cleanupOwnedLock, deferLockCleanup } from "./lock-disposal.ts";
import { lockedDestinationError, lstatBigInt } from "./parent.ts";
import type { TransactionTarget } from "./path.ts";
import {
  assertPathIdentity,
  changedRecoveryDestinationError,
  inspectDestination,
  privateSiblingPath,
  transactionLockPath,
} from "./path.ts";
import {
  cleanupOrphanedRecoveryLeases,
  withRecoveryLease,
} from "./recovery-lease.ts";
import { claimRetirementConfirmed } from "./retirement.ts";

export const PROMOTED_DIRECTORY_MODE = 0o755;

export async function recoverStaleTransaction(
  target: TransactionTarget,
  checkpoint?: ClaimCheckpoint,
) {
  await recoverClaimTemps(target);
  const claim = await inspectClaim(target);
  if (claim === undefined) {
    await cleanupOrphanedRecoveryLeases(target);
    if (await hasUnclaimedLockNamespace(target)) throw lockedDestinationError();
    return;
  }
  if (!(await claimRetirementConfirmed(claim))) throw lockedDestinationError();
  await withRecoveryLease(target, claim, checkpoint, async () => {
    await recoverDeferredCleanup(target, claim.owner);
    await recoverClaimLock(target, claim.owner);
    if (await transactionArtifactsRemain(target, claim.owner.token)) {
      throw lockedDestinationError();
    }
  });
}

async function recoverClaimLock(
  target: TransactionTarget,
  expectedOwner: LockOwner,
): Promise<void> {
  const lock = await inspectOwnedVariant(transactionLockPath(target));
  if (lock === undefined) return;
  let owner: LockOwner;
  try {
    owner = await readOwner(lock);
  } catch {
    await recoverUnknownClaimLock(lock);
    return;
  }
  if (!sameOwner(owner, expectedOwner)) throw lockedDestinationError();
  let journal: TransactionJournal;
  try {
    journal = await readJournal(lock, owner.token);
  } catch {
    const entries = await readdir(lock.path);
    if (
      entries.includes(JOURNAL_FILE) ||
      entries.includes(temporaryName(JOURNAL_FILE, owner.token))
    ) {
      throw lockedDestinationError();
    }
    await recoverMissingJournal(target, lock, owner);
    return;
  }
  await recoverJournal(target, lock, owner, journal);
}

async function recoverDeferredCleanup(
  target: TransactionTarget,
  expectedOwner: LockOwner,
) {
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
  if (owner.token !== token || !sameOwner(owner, expectedOwner)) {
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
