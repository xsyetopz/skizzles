import { link, open, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import { PackagingError } from "./contract.ts";
import type { ClaimCheckpoint, ClaimSnapshot } from "./destination-claim.ts";
import {
  inspectClaim,
  readClaim,
  removeClaim,
  sameOwner,
} from "./destination-claim.ts";
import {
  ownerForProcess,
  ownerRemainsActive,
  UUID_PATTERN,
} from "./destination-journal.ts";
import { isNodeError, lockedDestinationError } from "./destination-parent.ts";
import type { TransactionTarget } from "./destination-path.ts";
import { sameIdentity, transactionClaimPath } from "./destination-path.ts";

const LEASE_MODE = 0o600;
const HELPER_SOURCE = "await Bun.stdin.text();";
const GENERATION_PATTERN = /^[1-9][0-9]*$/u;

interface RecoveryLease extends ClaimSnapshot {
  generation: number;
  stopHelper: () => Promise<void>;
}

interface ExistingLease extends ClaimSnapshot {
  generation: number;
}

async function acquireRecoveryLease(
  target: TransactionTarget,
  checkpoint?: ClaimCheckpoint,
): Promise<RecoveryLease> {
  await recoverRecoveryLeaseTemps(target);
  const leases = await inspectRecoveryLeases(target);
  const latest = leases.at(-1);
  if (latest !== undefined && (await ownerRemainsActive(latest.owner))) {
    throw lockedDestinationError();
  }
  const generation = (latest?.generation ?? 0) + 1;
  const helper = Bun.spawn([process.execPath, "-e", HELPER_SOURCE], {
    stderr: "ignore",
    stdin: "pipe",
    stdout: "ignore",
  });
  await Promise.resolve(checkpoint?.("recovery-helper-ready"));
  let stopped = false;
  const stopHelper = async () => {
    if (stopped) return;
    stopped = true;
    helper.stdin.end();
    await helper.exited;
  };
  const owner = ownerForProcess(helper.pid);
  const leasePath = recoveryLeasePath(target, generation);
  const temporary = `${leasePath}.${owner.token}.tmp`;
  try {
    const handle = await open(temporary, "wx", LEASE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.chmod(LEASE_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await Promise.resolve(checkpoint?.("recovery-temp-ready", temporary));
    try {
      await link(temporary, leasePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw lockedDestinationError();
      }
      throw error;
    }
    await syncDirectory(target.parent);
    const lease = await readClaim(leasePath);
    if (lease === undefined || lease.owner.token !== owner.token) {
      throw new PackagingError("Plugin staging recovery lease changed.");
    }
    for (const previous of leases) {
      await removeClaim(previous).catch(() => undefined);
    }
    await Promise.resolve(checkpoint?.("recovery-lease-published", leasePath));
    return { ...lease, generation, stopHelper };
  } catch (error) {
    await stopHelper();
    throw error;
  } finally {
    await rm(temporary, { force: true });
    await syncDirectory(target.parent);
  }
}

async function retireRecoveryLease(
  target: TransactionTarget,
  lease: RecoveryLease,
  completed: boolean,
  checkpoint?: ClaimCheckpoint,
): Promise<void> {
  try {
    if (completed) {
      for (const existing of await inspectRecoveryLeases(target)) {
        await removeClaim(existing).catch(() => undefined);
      }
      await Promise.resolve(checkpoint?.("recovery-claim-released"));
    }
  } finally {
    await lease.stopHelper();
    await Promise.resolve(checkpoint?.("recovery-helper-stopped"));
  }
}

async function cleanupOrphanedRecoveryLeases(
  target: TransactionTarget,
): Promise<void> {
  await recoverRecoveryLeaseTemps(target);
  for (const lease of await inspectRecoveryLeases(target)) {
    if (!(await ownerRemainsActive(lease.owner))) {
      await removeClaim(lease).catch(() => undefined);
    }
  }
}

async function recoverRecoveryLeaseTemps(
  target: TransactionTarget,
): Promise<void> {
  const prefix = `${basename(transactionClaimPath(target))}.recovery-`;
  for (const name of (await readdir(target.parent)).sort()) {
    if (!(name.startsWith(prefix) && name.endsWith(".tmp"))) continue;
    const suffix = name.slice(prefix.length, -4);
    const separator = suffix.indexOf(".");
    const generation = suffix.slice(0, separator);
    const token = suffix.slice(separator + 1);
    if (
      separator < 1 ||
      !GENERATION_PATTERN.test(generation) ||
      !UUID_PATTERN.test(token)
    ) {
      throw lockedDestinationError();
    }
    const claim = await readClaim(join(target.parent, name));
    if (claim === undefined || claim.owner.token !== token) {
      throw lockedDestinationError();
    }
    if (!(await ownerRemainsActive(claim.owner))) await removeClaim(claim);
  }
}

async function withRecoveryLease(
  target: TransactionTarget,
  claim: ClaimSnapshot,
  checkpoint: ClaimCheckpoint | undefined,
  recover: () => Promise<void>,
): Promise<void> {
  const lease = await acquireRecoveryLease(target, checkpoint);
  let completed = false;
  try {
    const current = await inspectClaim(target);
    if (
      current === undefined ||
      !sameIdentity(current.identity, claim.identity) ||
      !sameOwner(current.owner, claim.owner)
    ) {
      throw lockedDestinationError();
    }
    await recover();
    await removeClaim(claim);
    completed = true;
  } finally {
    await retireRecoveryLease(target, lease, completed, checkpoint);
  }
}

async function inspectRecoveryLeases(
  target: TransactionTarget,
): Promise<ExistingLease[]> {
  const prefix = `${basename(transactionClaimPath(target))}.recovery-`;
  const leases: ExistingLease[] = [];
  for (const name of (await readdir(target.parent)).sort()) {
    if (!name.startsWith(prefix) || name.endsWith(".tmp")) continue;
    const generationText = name.slice(prefix.length);
    if (!GENERATION_PATTERN.test(generationText)) {
      throw lockedDestinationError();
    }
    const generation = Number(generationText);
    if (!Number.isSafeInteger(generation)) throw lockedDestinationError();
    const claim = await readClaim(join(target.parent, name));
    if (claim === undefined) throw lockedDestinationError();
    leases.push({ ...claim, generation });
  }
  leases.sort((left, right) => left.generation - right.generation);
  return leases;
}

function recoveryLeasePath(
  target: TransactionTarget,
  generation: number,
): string {
  return `${transactionClaimPath(target)}.recovery-${generation}`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type { RecoveryLease };
export {
  acquireRecoveryLease,
  cleanupOrphanedRecoveryLeases,
  retireRecoveryLease,
  withRecoveryLease,
};
