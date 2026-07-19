import { link, open, rm } from "node:fs/promises";
import process from "node:process";
import { PackagingError } from "./contract.ts";
import type { ClaimCheckpoint, ClaimSnapshot } from "./destination-claim.ts";
import {
  inspectClaim,
  readClaim,
  removeClaim,
  sameOwner,
} from "./destination-claim.ts";
import { ownerForProcess } from "./destination-journal.ts";
import { isNodeError, lockedDestinationError } from "./destination-parent.ts";
import type { TransactionTarget } from "./destination-path.ts";
import { sameIdentity } from "./destination-path.ts";
import {
  inspectRecoveryHighWaters,
  MAX_RECOVERY_GENERATION,
  recoverRecoveryHighWaterTemps,
  recoveryHighWaterPath,
} from "./destination-recovery-highwater.ts";
import {
  claimRetirementConfirmed,
  RETIREMENT_HELPER_SOURCE,
  removeRetirementArtifacts,
  sendRetirementBinding,
} from "./destination-retirement.ts";

const LEASE_MODE = 0o600;

interface RecoveryLease extends ClaimSnapshot {
  generation: number;
  stopHelper: () => Promise<void>;
}

async function acquireRecoveryLease(
  target: TransactionTarget,
  checkpoint?: ClaimCheckpoint,
): Promise<RecoveryLease> {
  await recoverRecoveryHighWaterTemps(target);
  let records = await inspectRecoveryHighWaters(target);
  let latest = records.at(-1);
  if (latest !== undefined) {
    if (!(await claimRetirementConfirmed(latest))) {
      throw lockedDestinationError();
    }
  }
  const helper = Bun.spawn([process.execPath, "-e", RETIREMENT_HELPER_SOURCE], {
    stderr: "ignore",
    stdin: "pipe",
    stdout: "ignore",
  });
  let stopped = false;
  const stopHelper = async () => {
    if (stopped) return;
    stopped = true;
    try {
      helper.stdin.end();
    } catch {}
    await helper.exited;
  };
  let retained = false;
  let temporary: string | undefined;
  try {
    await Promise.resolve(
      checkpoint?.("recovery-helper-ready", String(helper.pid)),
    );
    const owner = ownerForProcess(helper.pid);
    records = await inspectRecoveryHighWaters(target);
    latest = records.at(-1);
    if (latest !== undefined && !(await claimRetirementConfirmed(latest))) {
      throw lockedDestinationError();
    }
    const generation = (latest?.generation ?? 0) + 1;
    if (generation > MAX_RECOVERY_GENERATION) throw lockedDestinationError();
    const leasePath = recoveryHighWaterPath(target, generation);
    temporary = `${leasePath}.${owner.token}.tmp`;
    const handle = await open(temporary, "wx", LEASE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.chmod(LEASE_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await Promise.resolve(checkpoint?.("recovery-temp-ready", temporary));
    const prepared = await readClaim(temporary);
    if (prepared === undefined || prepared.owner.token !== owner.token) {
      throw new PackagingError("Plugin staging recovery high-water changed.");
    }
    await sendRetirementBinding(helper.stdin, {
      ...prepared,
      path: leasePath,
    });
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
    for (const previous of records) {
      await removeRetirementArtifacts(previous);
    }
    await Promise.resolve(checkpoint?.("recovery-lease-published", leasePath));
    retained = true;
    return { ...lease, generation, stopHelper };
  } finally {
    try {
      if (temporary !== undefined) await rm(temporary, { force: true });
      await syncDirectory(target.parent);
    } finally {
      if (!retained) await stopHelper();
    }
  }
}

async function retireRecoveryLease(
  target: TransactionTarget,
  lease: RecoveryLease,
  completed: boolean,
  checkpoint?: ClaimCheckpoint,
): Promise<void> {
  let stopped = false;
  try {
    if (completed) {
      await lease.stopHelper();
      stopped = true;
      if (!(await claimRetirementConfirmed(lease))) {
        throw lockedDestinationError();
      }
      for (const existing of await inspectRecoveryHighWaters(target)) {
        if (existing.generation >= lease.generation) continue;
        await removeRetirementArtifacts(existing);
      }
      await Promise.resolve(checkpoint?.("recovery-claim-released"));
    }
  } finally {
    if (!stopped) await lease.stopHelper();
    await Promise.resolve(checkpoint?.("recovery-helper-stopped"));
  }
}

async function cleanupOrphanedRecoveryLeases(
  target: TransactionTarget,
): Promise<void> {
  await recoverRecoveryHighWaterTemps(target);
  const records = await inspectRecoveryHighWaters(target);
  const latest = records.at(-1);
  if (latest !== undefined && !(await claimRetirementConfirmed(latest))) {
    throw lockedDestinationError();
  }
  for (const lease of records) {
    if (lease !== latest && (await claimRetirementConfirmed(lease))) {
      await removeRetirementArtifacts(lease);
    }
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
    await removeRetirementArtifacts(claim);
    completed = true;
  } finally {
    await retireRecoveryLease(target, lease, completed, checkpoint);
  }
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
