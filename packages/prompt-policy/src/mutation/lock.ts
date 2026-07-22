import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { validateText } from "../content-integrity.ts";
import type {
  MutationLockHooks,
  MutationOptions,
  ProcessIdentityProvider,
  TransactionOperation,
} from "../lifecycle/contract.ts";
import {
  LOCK_OWNER_PATH,
  LOCK_PATH,
  PROMPT_LAYER_ASSET_ROOT,
  PromptLayerError,
} from "../lifecycle/contract.ts";
import type { FileIdentity } from "../repository-boundary.ts";
import {
  assertCanonicalContainment,
  assertContainedPath,
  assertFilesystemIdentity,
  errorMessage,
  fileIdentity,
  isNodeError,
  pathExists,
  readRequiredFile,
  removeOwnedTree,
  syncDirectory,
  writeDurably,
} from "../repository-boundary.ts";
import {
  assertOwnerIsStale,
  defaultProcessIdentityProvider,
  processOwnerState,
  validProcessStartIdentity,
} from "./process-identity.ts";
import type { MutationLockOwner, ReclaimClaim } from "./protocol.ts";
import {
  LOCK_VERSION,
  lockOwnerBytes,
  lockOwnerValue,
  readMutationOwner,
  reclaimClaimValue,
  sameLockOwner,
} from "./protocol.ts";
import {
  cleanupMutationOrphans,
  removeOwnedLockDirectory,
} from "./quarantine.ts";

const INCOMPLETE_LOCK_GRACE_MS = 30_000;

interface MutationLockHandle {
  root: string;
  owner: MutationLockOwner;
  identity: FileIdentity;
}

interface MutationRuntime {
  hooks: MutationLockHooks | undefined;
  processIdentityProvider: ProcessIdentityProvider;
  incompleteLockGraceMs: number;
}

export async function withMutationLock<T>(
  root: string,
  operation: TransactionOperation,
  options: MutationOptions,
  work: () => Promise<T>,
): Promise<T> {
  await assertCanonicalContainment(root);
  const runtime = mutationRuntime(options);
  const lock = await acquireMutationLock(root, operation, runtime);
  try {
    await runtime.hooks?.afterAcquire?.();
    return await work();
  } finally {
    await releaseMutationLock(lock, runtime);
  }
}

async function acquireMutationLock(
  root: string,
  operation: TransactionOperation,
  runtime: MutationRuntime,
): Promise<MutationLockHandle> {
  await cleanupMutationOrphans(root, runtime.processIdentityProvider, true);
  const owner = await newLockOwner(operation, runtime.processIdentityProvider);
  const created = await createMutationLock(root, owner, runtime.hooks);
  if (created !== undefined) {
    return created;
  }
  return reclaimStaleMutationLock(root, owner, runtime);
}

function mutationRuntime(options: MutationOptions): MutationRuntime {
  const grace = options.incompleteLockGraceMs ?? INCOMPLETE_LOCK_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 0) {
    throw new PromptLayerError(
      "Prompt mutation incomplete-lock grace must be a non-negative safe integer.",
    );
  }
  return {
    hooks: options.lockHooks,
    processIdentityProvider:
      options.processIdentityProvider ?? defaultProcessIdentityProvider,
    incompleteLockGraceMs: grace,
  };
}

async function newLockOwner(
  operation: TransactionOperation,
  provider: ProcessIdentityProvider,
): Promise<MutationLockOwner> {
  const processStartIdentity = await provider.processStartIdentity(process.pid);
  if (!validProcessStartIdentity(processStartIdentity)) {
    throw new PromptLayerError(
      "Cannot establish the current process start identity; refusing to publish a mutation lock.",
    );
  }
  return {
    version: LOCK_VERSION,
    operation,
    pid: process.pid,
    processStartIdentity,
    token: randomUUID(),
    createdAtUnixMs: Date.now(),
  };
}

async function createMutationLock(
  root: string,
  owner: MutationLockOwner,
  hooks?: MutationLockHooks,
): Promise<MutationLockHandle | undefined> {
  await assertContainedPath(root, LOCK_PATH, false);
  const lockPath = join(root, LOCK_PATH);
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
  await syncDirectory(dirname(lockPath));
  const identity = fileIdentity(await lstat(lockPath));
  try {
    await hooks?.beforeOwnerWrite?.();
    await assertFilesystemIdentity(
      lockPath,
      identity,
      "Prompt mutation lock changed before owner publication.",
    );
    await assertContainedPath(root, LOCK_OWNER_PATH, false);
    await writeDurably(join(root, LOCK_OWNER_PATH), lockOwnerBytes(owner));
    await verifyOwnedLock(root, identity, owner, "initialization");
  } catch (error) {
    await removeOwnedLockDirectory(root, identity, owner.token);
    throw error;
  }
  return { root, owner, identity };
}

async function reclaimStaleMutationLock(
  root: string,
  replacement: MutationLockOwner,
  runtime: MutationRuntime,
): Promise<MutationLockHandle> {
  await assertContainedPath(root, LOCK_PATH, true);
  const lockMetadata = await lstat(join(root, LOCK_PATH));
  if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()) {
    throw new PromptLayerError("Prompt mutation lock is not a safe directory.");
  }
  const identity = fileIdentity(lockMetadata);
  const current = await readExistingLockOwner(
    root,
    lockMetadata.mtimeMs,
    runtime.incompleteLockGraceMs,
  );
  if (current !== undefined) {
    await assertOwnerIsStale(current, runtime.processIdentityProvider);
  }
  const reclaimPath = `${LOCK_PATH}/reclaim.json`;
  await clearStaleReclaimClaim(root, reclaimPath, identity, runtime);
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    identity,
    "Prompt mutation lock changed before reclaim publication.",
  );
  await assertContainedPath(root, reclaimPath, false);
  try {
    await writeDurably(
      join(root, reclaimPath),
      Buffer.from(
        `${JSON.stringify(
          {
            version: LOCK_VERSION,
            pid: process.pid,
            processStartIdentity: replacement.processStartIdentity,
            token: replacement.token,
            createdAtUnixMs: Date.now(),
          },
          null,
          2,
        )}\n`,
      ),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new PromptLayerError(
        "Another process is already reclaiming the stale prompt mutation lock.",
      );
    }
    throw error;
  }
  await verifyReclaimIdentity(root, current, identity, runtime);
  const quarantineToken = current?.token ?? replacement.token;
  const quarantine = `${PROMPT_LAYER_ASSET_ROOT}/.mutation-stale-${quarantineToken}`;
  await assertContainedPath(root, quarantine, false);
  await verifyReclaimIdentity(root, current, identity, runtime);
  await rename(join(root, LOCK_PATH), join(root, quarantine));
  await syncDirectory(dirname(join(root, LOCK_PATH)));
  await assertFilesystemIdentity(
    join(root, quarantine),
    identity,
    "Prompt stale-lock quarantine did not preserve the reclaimed lock identity.",
  );
  await runtime.hooks?.afterStaleQuarantine?.(join(root, LOCK_PATH));
  const acquired = await createMutationLock(root, replacement, runtime.hooks);
  await removeOwnedTree(root, quarantine, identity);
  if (acquired === undefined) {
    throw new PromptLayerError(
      "A replacement prompt mutation owner acquired the lock during stale reclaim; it was preserved.",
    );
  }
  return acquired;
}

async function clearStaleReclaimClaim(
  root: string,
  reclaimPath: string,
  lockIdentity: FileIdentity,
  runtime: MutationRuntime,
): Promise<void> {
  const absolute = join(root, reclaimPath);
  if (!(await pathExists(absolute))) {
    return;
  }
  await assertContainedPath(root, reclaimPath, true);
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    lockIdentity,
    "Prompt mutation lock changed while inspecting its reclaim claim.",
  );
  const claimIdentity = fileIdentity(await lstat(absolute));
  let claim: ReclaimClaim;
  try {
    const bytes = await readRequiredFile(absolute, "prompt lock reclaim claim");
    validateText(bytes, "prompt lock reclaim claim");
    claim = reclaimClaimValue(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    const metadata = await lstat(absolute);
    if (Date.now() - metadata.mtimeMs < runtime.incompleteLockGraceMs) {
      throw new PromptLayerError(
        `Prompt lock reclaim claim is incomplete inside its bounded grace period: ${errorMessage(error)}`,
      );
    }
    await assertFilesystemIdentity(
      absolute,
      claimIdentity,
      "Prompt reclaim claim changed before incomplete-claim cleanup.",
    );
    await assertFilesystemIdentity(
      join(root, LOCK_PATH),
      lockIdentity,
      "Prompt mutation lock changed before incomplete-claim cleanup.",
    );
    await rm(absolute);
    await syncDirectory(dirname(absolute));
    return;
  }
  const state = await processOwnerState(claim, runtime.processIdentityProvider);
  if (state !== "stale") {
    throw new PromptLayerError(
      `Prompt mutation lock reclaim is owned by live pid ${claim.pid}.`,
    );
  }
  await assertFilesystemIdentity(
    absolute,
    claimIdentity,
    "Prompt reclaim claim changed before stale-claim cleanup.",
  );
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    lockIdentity,
    "Prompt mutation lock changed before stale-claim cleanup.",
  );
  await rm(absolute);
  await syncDirectory(dirname(absolute));
}

async function readExistingLockOwner(
  root: string,
  lockMtimeMs: number,
  graceMs: number,
): Promise<MutationLockOwner | undefined> {
  if (!(await pathExists(join(root, LOCK_OWNER_PATH)))) {
    if (Date.now() - lockMtimeMs < graceMs) {
      throw new PromptLayerError(
        "Prompt mutation lock initialization is incomplete and still inside its bounded grace period.",
      );
    }
    return;
  }
  await assertContainedPath(root, LOCK_OWNER_PATH, true);
  const bytes = await readRequiredFile(
    join(root, LOCK_OWNER_PATH),
    "prompt mutation lock owner",
  );
  validateText(bytes, "prompt mutation lock owner");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new PromptLayerError(
      `Prompt mutation lock owner is invalid: ${errorMessage(error)}`,
    );
  }
  return lockOwnerValue(parsed);
}

async function verifyReclaimIdentity(
  root: string,
  expected: MutationLockOwner | undefined,
  expectedIdentity: FileIdentity,
  runtime: MutationRuntime,
): Promise<void> {
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    expectedIdentity,
    "Prompt mutation lock changed during stale-owner reclaim.",
  );
  if (expected === undefined) {
    if (await pathExists(join(root, LOCK_OWNER_PATH))) {
      throw new PromptLayerError(
        "Prompt mutation lock acquired an owner during stale reclaim.",
      );
    }
    return;
  }
  const current = await readExistingLockOwner(
    root,
    expected.createdAtUnixMs,
    runtime.incompleteLockGraceMs,
  );
  if (
    current === undefined ||
    current.pid !== expected.pid ||
    current.processStartIdentity !== expected.processStartIdentity ||
    current.token !== expected.token
  ) {
    throw new PromptLayerError(
      "Prompt mutation lock ownership changed during stale reclaim.",
    );
  }
  await assertOwnerIsStale(current, runtime.processIdentityProvider);
}

async function releaseMutationLock(
  lock: MutationLockHandle,
  runtime: MutationRuntime,
): Promise<void> {
  await assertFilesystemIdentity(
    join(lock.root, LOCK_PATH),
    lock.identity,
    "Prompt mutation lock identity changed before release.",
  );
  await assertContainedPath(lock.root, LOCK_OWNER_PATH, true);
  const current = await readExistingLockOwner(
    lock.root,
    lock.owner.createdAtUnixMs,
    runtime.incompleteLockGraceMs,
  );
  if (!sameLockOwner(current, lock.owner)) {
    throw new PromptLayerError(
      "Prompt mutation lock ownership changed before release; refusing deletion.",
    );
  }
  const releasePath = `${PROMPT_LAYER_ASSET_ROOT}/.mutation-release-${lock.owner.token}`;
  await assertContainedPath(lock.root, releasePath, false);
  await verifyOwnedLock(lock.root, lock.identity, lock.owner, "release");
  await rename(join(lock.root, LOCK_PATH), join(lock.root, releasePath));
  await syncDirectory(dirname(join(lock.root, LOCK_PATH)));
  await assertFilesystemIdentity(
    join(lock.root, releasePath),
    lock.identity,
    "Prompt release quarantine did not preserve the acquired lock identity.",
  );
  await runtime.hooks?.afterReleaseQuarantine?.(join(lock.root, releasePath));
  await removeOwnedTree(lock.root, releasePath, lock.identity);
}

export async function assertNoActiveMutation(
  root: string,
  provider: ProcessIdentityProvider,
): Promise<void> {
  await cleanupMutationOrphans(root, provider, false);
  await assertContainedPath(root, LOCK_PATH, false);
  if (await pathExists(join(root, LOCK_PATH))) {
    throw new PromptLayerError(
      "A prompt mutation is active; prompt:check refuses to recover or write.",
    );
  }
}

async function verifyOwnedLock(
  root: string,
  identity: FileIdentity,
  expected: MutationLockOwner,
  phase: string,
): Promise<void> {
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    identity,
    `Prompt mutation lock identity changed during ${phase}.`,
  );
  const actual = await readMutationOwner(root, LOCK_OWNER_PATH);
  if (!sameLockOwner(actual, expected)) {
    throw new PromptLayerError(
      `Prompt mutation lock ownership changed during ${phase}.`,
    );
  }
}
