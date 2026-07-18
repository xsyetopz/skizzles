import { constants } from "node:fs";
import { link, open, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { PackagingError } from "./contract.ts";
import type { OwnedDirectory } from "./destination-artifacts.ts";
import {
  assertOwnedDirectory,
  inspectOwnedVariant,
} from "./destination-artifacts.ts";
import type { LockOwner } from "./destination-journal.ts";
import {
  ownerForProcess,
  ownerRemainsActive,
  parseOwner,
  parsePrivateJson,
  UUID_PATTERN,
} from "./destination-journal.ts";
import { isNodeError, lockedDestinationError } from "./destination-parent.ts";
import type { FileIdentity, TransactionTarget } from "./destination-path.ts";
import {
  identity,
  privateSiblingPath,
  revalidateAncestors,
  sameIdentity,
  transactionClaimPath,
  transactionLockPath,
} from "./destination-path.ts";

const CLAIM_MODE = 0o600;
const HELPER_SOURCE = "await Bun.stdin.text();";

// The claim temp and canonical path share a parent: POSIX hard-link creation
// supplies atomic no-replace publication, and pipe EOF retires isolate owners.
// Filesystems without hard links and hosts without `ps` fail closed.

interface ClaimSnapshot {
  identity: FileIdentity;
  owner: LockOwner;
  path: string;
}

interface OwnedClaim extends ClaimSnapshot {
  stopHelper: () => Promise<void>;
}

type ClaimPoint =
  | "claim-helper-ready"
  | "claim-temp-ready"
  | "claim-published"
  | "claim-release-ready"
  | "claim-released"
  | "claim-helper-stopped"
  | "recovery-helper-ready"
  | "recovery-temp-ready"
  | "recovery-lease-published"
  | "recovery-claim-released"
  | "recovery-helper-stopped";
type ClaimCheckpoint = (
  point: ClaimPoint,
  path?: string,
) => Promise<void> | void;

async function acquireClaim(
  target: TransactionTarget,
  checkpoint?: ClaimCheckpoint,
): Promise<OwnedClaim> {
  await revalidateAncestors(target.ancestors);
  const helper = Bun.spawn([process.execPath, "-e", HELPER_SOURCE], {
    stderr: "ignore",
    stdin: "pipe",
    stdout: "ignore",
  });
  let helperStopped = false;
  const stopHelper = async () => {
    if (helperStopped) return;
    helperStopped = true;
    helper.stdin.end();
    await helper.exited;
  };
  await checkpoint?.("claim-helper-ready");
  const owner = ownerForProcess(helper.pid);
  const canonical = transactionClaimPath(target);
  const temporary = join(
    target.parent,
    `.skizzles-package-${target.key}-claim-${owner.token}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", CLAIM_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.chmod(CLAIM_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkpoint?.("claim-temp-ready", temporary);
    try {
      await link(temporary, canonical);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw lockedDestinationError();
      }
      throw error;
    }
    await syncDirectory(target.parent);
    const claim = await readClaim(canonical);
    if (claim === undefined || claim.owner.token !== owner.token) {
      throw new PackagingError("Plugin staging claim changed unexpectedly.");
    }
    await checkpoint?.("claim-published", canonical);
    return { ...claim, stopHelper };
  } catch (error) {
    await stopHelper();
    throw error;
  } finally {
    await rm(temporary, { force: true });
    await syncDirectory(target.parent);
  }
}

async function readClaim(path: string): Promise<ClaimSnapshot | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new PackagingError("Plugin staging claim is unsafe.", {
      cause: error,
    });
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || (metadata.mode & 0o777n) !== 0o600n) {
      throw new PackagingError("Plugin staging claim is unsafe.");
    }
    const owner = parseOwner(parsePrivateJson(await handle.readFile("utf8")));
    return { path, identity: identity(metadata), owner };
  } finally {
    await handle.close();
  }
}

async function inspectClaim(
  target: TransactionTarget,
): Promise<ClaimSnapshot | undefined> {
  return readClaim(transactionClaimPath(target));
}

async function removeClaim(claim: ClaimSnapshot): Promise<void> {
  const current = await readClaim(claim.path);
  if (
    current === undefined ||
    !sameIdentity(current.identity, claim.identity) ||
    current.owner.token !== claim.owner.token
  ) {
    throw new PackagingError("Plugin staging claim changed unexpectedly.");
  }
  await unlink(claim.path);
  await syncDirectory(dirname(claim.path));
}

async function retireClaim(
  claim: OwnedClaim,
  remove: boolean,
  checkpoint?: ClaimCheckpoint,
): Promise<void> {
  try {
    await checkpoint?.("claim-release-ready", claim.path);
    if (remove) {
      await removeClaim(claim);
      await checkpoint?.("claim-released", claim.path);
    }
  } finally {
    await claim.stopHelper();
    await checkpoint?.("claim-helper-stopped");
  }
}

async function recoverClaimTemps(target: TransactionTarget): Promise<void> {
  const prefix = `.skizzles-package-${target.key}-claim-`;
  const candidates = (await readdir(target.parent))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
    .sort();
  for (const candidate of candidates) {
    const token = candidate.slice(prefix.length, -4);
    if (!UUID_PATTERN.test(token)) throw lockedDestinationError();
    const claim = await readClaim(join(target.parent, candidate));
    if (claim === undefined || claim.owner.token !== token) {
      throw lockedDestinationError();
    }
    if (!(await ownerRemainsActive(claim.owner))) await removeClaim(claim);
  }
}

async function hasUnclaimedLockNamespace(
  target: TransactionTarget,
): Promise<boolean> {
  const cleanupPrefix = `.skizzles-package-${target.key}-cleanup-`;
  if (
    (await readdir(target.parent)).some((name) =>
      name.startsWith(cleanupPrefix),
    )
  ) {
    return true;
  }
  return (await inspectOwnedVariant(transactionLockPath(target))) !== undefined;
}

async function transactionArtifactsRemain(
  target: TransactionTarget,
  token: string,
): Promise<boolean> {
  const stage = inspectOwnedVariant(privateSiblingPath(target, "stage", token));
  const backup = inspectOwnedVariant(
    privateSiblingPath(target, "backup", token),
  );
  return (await stage) !== undefined || (await backup) !== undefined;
}

async function recoverUnknownClaimLock(lock: OwnedDirectory): Promise<void> {
  await assertOwnedDirectory(lock, "private destination lock");
  if ((await readdir(lock.path)).length !== 0) throw lockedDestinationError();
  try {
    await rmdir(lock.path);
    lock.present = false;
  } catch {
    throw lockedDestinationError();
  }
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return (
    left.version === right.version &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.token === right.token
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type { ClaimCheckpoint, ClaimPoint, ClaimSnapshot, OwnedClaim };
export {
  acquireClaim,
  hasUnclaimedLockNamespace,
  inspectClaim,
  readClaim,
  recoverClaimTemps,
  recoverUnknownClaimLock,
  removeClaim,
  retireClaim,
  sameOwner,
  transactionArtifactsRemain,
};
