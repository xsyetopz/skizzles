import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PackagingError } from "./contract.ts";
import type {
  FileIdentity,
  PathSnapshot,
  TransactionTarget,
} from "./destination-path.ts";
import {
  identity,
  revalidateAncestors,
  sameIdentity,
} from "./destination-path.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;

interface OwnedDirectory extends PathSnapshot {
  present: boolean;
}

async function acquireLock(target: TransactionTarget): Promise<OwnedDirectory> {
  await revalidateAncestors(target.ancestors);
  const path = join(target.parent, `.skizzles-package-${target.key}.lock`);
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new PackagingError(
        "Plugin staging destination is locked by another operation.",
        { cause: error },
      );
    }
    throw new PackagingError(
      "Plugin staging could not acquire the destination lock.",
      { cause: error },
    );
  }
  let owned: OwnedDirectory | undefined;
  try {
    owned = await ownedDirectory(path);
    await chmod(path, PRIVATE_DIRECTORY_MODE);
    await assertOwnedDirectory(owned, "private destination lock");
    return owned;
  } catch (error) {
    await cleanupOwned(owned, undefined);
    throw new PackagingError(
      "Plugin staging could not establish a private destination lock.",
      { cause: error },
    );
  }
}

async function createPrivateSibling(
  target: TransactionTarget,
  kind: "backup" | "stage",
): Promise<OwnedDirectory> {
  await revalidateAncestors(target.ancestors);
  let owned: OwnedDirectory | undefined;
  try {
    const path = await mkdtemp(
      join(target.parent, `.skizzles-package-${target.key}-${kind}-`),
    );
    owned = await ownedDirectory(path);
    await chmod(path, PRIVATE_DIRECTORY_MODE);
    await assertOwnedDirectory(owned, `private ${kind} directory`);
  } catch (error) {
    await cleanupOwned(owned, undefined);
    throw new PackagingError(
      `Plugin staging could not create its private ${kind} directory.`,
      { cause: error },
    );
  }
  const parentIdentity = target.ancestors.at(-1)?.identity;
  if (
    parentIdentity === undefined ||
    owned.identity.dev !== parentIdentity.dev
  ) {
    await cleanupOwned(owned, undefined);
    throw new PackagingError(
      `Plugin staging private ${kind} directory is on the wrong filesystem.`,
    );
  }
  return owned;
}

async function ownedDirectory(path: string): Promise<OwnedDirectory> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PackagingError("Plugin staging private artifact is unsafe.");
  }
  return { path, identity: identity(metadata), present: true };
}

async function assertOwnedDirectory(
  owned: OwnedDirectory,
  label: string,
): Promise<void> {
  if (!owned.present) {
    throw new PackagingError(`Plugin staging ${label} is missing.`);
  }
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(owned.path);
  } catch (error) {
    throw new PackagingError(`Plugin staging ${label} changed unexpectedly.`, {
      cause: error,
    });
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !sameIdentity(owned.identity, identity(metadata))
  ) {
    throw new PackagingError(`Plugin staging ${label} changed unexpectedly.`);
  }
}

async function assertPathIdentity(
  path: string,
  expected: FileIdentity | undefined,
): Promise<void> {
  if (expected === undefined) {
    throw new PackagingError("Plugin staging path identity is unavailable.");
  }
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !sameIdentity(expected, identity(metadata))
  ) {
    throw new PackagingError("Plugin staging path identity changed.");
  }
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new PackagingError(
    "Plugin staging destination changed during rollback.",
  );
}

async function removeOwnedDirectory(owned: OwnedDirectory): Promise<void> {
  if (!owned.present) {
    return;
  }
  await assertOwnedDirectory(owned, "private artifact");
  await rm(owned.path, { recursive: true });
  owned.present = false;
}

async function cleanupOwned(
  owned: OwnedDirectory | undefined,
  failure: unknown,
): Promise<unknown> {
  if (owned === undefined || !owned.present) {
    return failure;
  }
  try {
    await removeOwnedDirectory(owned);
    return failure;
  } catch {
    if (failure === undefined) {
      return new PackagingError(
        "Plugin staging could not clean up its private artifact.",
      );
    }
    return new PackagingError(
      "Plugin staging failed and could not clean up its private artifact safely.",
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export type { OwnedDirectory };
export {
  acquireLock,
  assertOwnedDirectory,
  assertPathAbsent,
  assertPathIdentity,
  cleanupOwned,
  createPrivateSibling,
  removeOwnedDirectory,
};
