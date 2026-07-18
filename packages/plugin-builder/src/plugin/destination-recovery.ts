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
  temporaryName,
} from "./destination-artifacts.ts";
import type { LockOwner, TransactionJournal } from "./destination-parent.ts";
import {
  deserialize,
  lstatBigInt,
  matches,
  parseJournal,
  requiredRecord,
} from "./destination-parent.ts";
import type {
  DestinationSnapshot,
  TransactionTarget,
} from "./destination-path.ts";
import {
  assertPathAbsent,
  assertPathIdentity,
  changedRecoveryDestinationError,
  inspectDestination,
  privateSiblingPath,
  transactionLockPath,
} from "./destination-path.ts";

const OWNER_FILE = "owner.json";
const JOURNAL_FILE = "journal.json";
const PROTOCOL_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PROMOTED_DIRECTORY_MODE = 0o755;
const INCOMPLETE_LOCK_STALE_MS = 30_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class IncompleteRollbackError extends PackagingError {}

interface PromotionRollback {
  backup: OwnedDirectory | undefined;
  original: DestinationSnapshot;
  previousMoved: boolean;
  stage: OwnedDirectory;
  stageMoved: boolean;
  target: TransactionTarget;
}

function ownerIsActive(owner: LockOwner): boolean {
  return processIdentity(owner.pid) === owner.processStartIdentity;
}

function lockedDestinationError(): PackagingError {
  return new PackagingError(
    "Plugin staging destination is locked by another operation.",
  );
}

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

async function recoverStaleTransaction(
  target: TransactionTarget,
): Promise<void> {
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
    if (ownerIsActive(owner)) throw lockedDestinationError();
    await recoverMissingJournal(target, lock, owner);
    return;
  }
  if (journal.state !== "cleanup-pending" && ownerIsActive(owner)) {
    throw lockedDestinationError();
  }
  await recoverJournal(target, lock, owner, journal);
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
  const stage = await recoverableArtifact(
    target,
    "stage",
    owner.token,
    journal.stage,
  );
  const backup =
    journal.backup === undefined
      ? await inspectUnrecordedEmptyBackup(target, owner.token)
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
    await quarantineTransactionLock(target, lock, owner.token);
    return;
  }
  await cleanupOwned(lock, undefined);
}

async function rollbackOwnedPromotion(
  rollback: PromotionRollback,
): Promise<void> {
  const { backup, original, previousMoved, stage, stageMoved, target } =
    rollback;
  if (stageMoved) {
    await assertPathIdentity(target.destination, stage.identity);
    await rename(target.destination, stage.path);
    stage.present = true;
    await assertOwnedDirectory(stage, "private construction directory");
    await chmod(stage.path, PRIVATE_DIRECTORY_MODE);
    await assertOwnedDirectory(stage, "private construction directory");
  }
  if (previousMoved && backup !== undefined) {
    await assertPathAbsent(target.destination);
    const previous = join(backup.path, "previous");
    await assertPathIdentity(previous, original.identity);
    await rename(previous, target.destination);
  }
  await cleanupOwned(backup, undefined);
}

async function readOwner(lock: OwnedDirectory): Promise<LockOwner> {
  try {
    return parseOwner(await readOwnedJson(lock, OWNER_FILE));
  } catch {
    const prefix = `.${OWNER_FILE}.`;
    const candidates = (await readdir(lock.path)).filter(
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
}

async function readJournal(
  lock: OwnedDirectory,
  token: string,
): Promise<TransactionJournal> {
  const temporary = temporaryName(JOURNAL_FILE, token);
  if ((await readdir(lock.path)).includes(temporary)) {
    try {
      return parseJournal(
        await readOwnedJson(lock, temporary),
        PROTOCOL_VERSION,
      );
    } catch {
      // A partial next publication leaves the last atomic journal authoritative.
    }
  }
  return parseJournal(
    await readOwnedJson(lock, JOURNAL_FILE),
    PROTOCOL_VERSION,
  );
}

async function inspectUnrecordedEmptyBackup(
  target: TransactionTarget,
  token: string,
): Promise<OwnedDirectory | undefined> {
  const backup = await inspectOwnedDirectory(
    privateSiblingPath(target, "backup", token),
  );
  if (backup !== undefined && (await readdir(backup.path)).length > 0) {
    throw lockedDestinationError();
  }
  return backup;
}

function parseOwner(value: unknown): LockOwner {
  const record = requiredRecord(value);
  if (
    Object.keys(record).length !== 4 ||
    record["version"] !== PROTOCOL_VERSION ||
    !Number.isSafeInteger(record["pid"]) ||
    typeof record["processStartIdentity"] !== "string" ||
    typeof record["token"] !== "string" ||
    !UUID_PATTERN.test(record["token"])
  ) {
    throw new Error("invalid owner");
  }
  return {
    version: PROTOCOL_VERSION,
    pid: Number(record["pid"]),
    processStartIdentity: record["processStartIdentity"],
    token: record["token"],
  };
}

export type { PromotionRollback };
export {
  IncompleteRollbackError,
  JOURNAL_FILE,
  OWNER_FILE,
  PROMOTED_DIRECTORY_MODE,
  PROTOCOL_VERSION,
  processIdentity,
  readJournal,
  recoverStaleTransaction,
  rollbackOwnedPromotion,
};
