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
import { ownerForProcess, UUID_PATTERN } from "./destination-journal.ts";
import { isNodeError, lockedDestinationError } from "./destination-parent.ts";
import type { TransactionTarget } from "./destination-path.ts";
import { sameIdentity, transactionClaimPath } from "./destination-path.ts";
import {
  claimRetirementConfirmed,
  hasValidRetirementMarker,
  RETIREMENT_HELPER_SOURCE,
  removeRetirementArtifacts,
  sendRetirementBinding,
} from "./destination-retirement.ts";

const LEASE_MODE = 0o600;
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
  if (latest !== undefined) {
    if (!(await claimRetirementConfirmed(latest))) {
      throw lockedDestinationError();
    }
  }
  const generation = (latest?.generation ?? 0) + 1;
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
    const leasePath = recoveryLeasePath(target, generation);
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
    try {
      await sendRetirementBinding(helper.stdin, lease);
    } catch (error) {
      await removeClaim(lease).catch(() => undefined);
      throw error;
    }
    for (const previous of leases) {
      try {
        await removeClaim(previous);
        await removeRetirementArtifacts(previous);
      } catch {}
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
  try {
    if (completed) {
      for (const existing of await inspectRecoveryLeases(target)) {
        try {
          await removeClaim(existing);
          await removeRetirementArtifacts(existing);
        } catch {}
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
    if (await claimRetirementConfirmed(lease)) {
      try {
        await removeClaim(lease);
        await removeRetirementArtifacts(lease);
      } catch {}
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
    const markerTemp = parseRetirementMarkerTemp(suffix);
    if (markerTemp !== undefined) {
      const lease = await readClaim(
        recoveryLeasePath(target, markerTemp.generation),
      );
      if (lease === undefined || lease.owner.token !== markerTemp.token) {
        throw lockedDestinationError();
      }
      continue;
    }
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
    if (await claimRetirementConfirmed(claim)) {
      await removeClaim(claim);
      await removeRetirementArtifacts(claim);
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

async function inspectRecoveryLeases(
  target: TransactionTarget,
): Promise<ExistingLease[]> {
  const prefix = `${basename(transactionClaimPath(target))}.recovery-`;
  const leases: ExistingLease[] = [];
  for (const name of (await readdir(target.parent)).sort()) {
    if (!name.startsWith(prefix) || name.endsWith(".tmp")) continue;
    const generationText = name.slice(prefix.length);
    const markerGeneration = parseRetirementMarker(generationText);
    if (markerGeneration !== undefined) {
      const lease = await readClaim(
        recoveryLeasePath(target, markerGeneration),
      );
      if (lease === undefined || !(await hasValidRetirementMarker(lease))) {
        throw lockedDestinationError();
      }
      continue;
    }
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

function parseRetirementMarker(value: string): number | undefined {
  const suffix = ".retired";
  if (!value.endsWith(suffix)) return;
  const generation = value.slice(0, -suffix.length);
  if (!GENERATION_PATTERN.test(generation)) return;
  const parsed = Number(generation);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRetirementMarkerTemp(
  value: string,
): { generation: number; token: string } | undefined {
  const separator = value.indexOf(".retired.");
  if (separator < 1) return;
  const generation = value.slice(0, separator);
  const token = value.slice(separator + ".retired.".length);
  if (!GENERATION_PATTERN.test(generation) || !UUID_PATTERN.test(token)) return;
  const parsed = Number(generation);
  return Number.isSafeInteger(parsed)
    ? { generation: parsed, token }
    : undefined;
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
