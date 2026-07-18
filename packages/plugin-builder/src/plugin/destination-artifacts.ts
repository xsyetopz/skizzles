import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { PackagingError } from "./contract.ts";
import { parsePrivateJson, temporaryName } from "./destination-journal.ts";
import { isNodeError, lstatBigInt } from "./destination-parent.ts";
import type { PathSnapshot, TransactionTarget } from "./destination-path.ts";
import {
  disposalPath,
  identity,
  restoreQuarantinedPath,
  revalidateAncestors,
  sameIdentity,
  transactionLockPath,
} from "./destination-path.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;

interface OwnedDirectory extends PathSnapshot {
  present: boolean;
}

interface RemovalHooks {
  afterRename?: (path: string) => Promise<void> | void;
  beforeRemove?: (path: string) => Promise<void> | void;
  beforeRename?: () => Promise<void> | void;
}

type CleanupOutcome = { failure: unknown; removed: boolean };

async function acquireLock(target: TransactionTarget): Promise<OwnedDirectory> {
  await revalidateAncestors(target.ancestors);
  const path = transactionLockPath(target);
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
  token: string,
): Promise<OwnedDirectory> {
  await revalidateAncestors(target.ancestors);
  let owned: OwnedDirectory | undefined;
  try {
    const path = join(
      target.parent,
      `.skizzles-package-${target.key}-${kind}-${token}`,
    );
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
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
  const metadata = await lstatBigInt(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PackagingError("Plugin staging private artifact is unsafe.");
  }
  return { path, identity: identity(metadata), present: true };
}

async function inspectOwnedDirectory(
  path: string,
): Promise<OwnedDirectory | undefined> {
  try {
    return await ownedDirectory(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function readOwnedJson(
  owned: OwnedDirectory,
  name: string,
): Promise<unknown> {
  await assertOwnedDirectory(owned, "private artifact");
  return parsePrivateJson(await readFile(join(owned.path, name), "utf8"));
}

async function writeOwnedJson(
  owned: OwnedDirectory,
  name: string,
  value: unknown,
  token: string,
  beforePublish?: () => Promise<void> | void,
): Promise<void> {
  await assertOwnedDirectory(owned, "private artifact");
  const temporary = join(owned.path, temporaryName(name, token));
  await rm(temporary, { force: true });
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await beforePublish?.();
  await rename(temporary, join(owned.path, name));
  await syncDirectory(owned.path);
  await assertOwnedDirectory(owned, "private artifact");
}

async function quarantineOwnedDirectory(
  owned: OwnedDirectory,
  path: string,
  beforeRename?: () => Promise<void> | void,
): Promise<void> {
  await assertOwnedDirectory(owned, "private artifact");
  await assertPathMissing(path);
  const original = owned.path;
  await beforeRename?.();
  await rename(owned.path, path);
  owned.path = path;
  try {
    await assertOwnedDirectory(owned, "private artifact");
  } catch (error) {
    owned.path = original;
    await restoreQuarantinedPath(path, original);
    throw error;
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

async function assertOwnedDirectory(
  owned: OwnedDirectory,
  label: string,
): Promise<void> {
  if (!owned.present) {
    throw new PackagingError(`Plugin staging ${label} is missing.`);
  }
  let metadata: Awaited<ReturnType<typeof lstatBigInt>>;
  try {
    metadata = await lstatBigInt(owned.path);
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

async function removeOwnedDirectory(
  owned: OwnedDirectory,
  hooks: RemovalHooks = {},
): Promise<void> {
  if (!owned.present) {
    return;
  }
  if (!owned.path.endsWith(".dispose")) {
    await quarantineOwnedDirectory(
      owned,
      disposalPath(owned.path),
      hooks.beforeRename,
    );
    await hooks.afterRename?.(owned.path);
  }
  await hooks.beforeRemove?.(owned.path);
  await rm(owned.path, { recursive: true });
  owned.present = false;
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await lstatBigInt(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new PackagingError("Plugin staging private quarantine path exists.");
}

async function cleanupOwned(
  owned: OwnedDirectory | undefined,
  failure: unknown,
  hooks?: RemovalHooks,
): Promise<CleanupOutcome> {
  if (owned === undefined || !owned.present) {
    return { failure, removed: true };
  }
  try {
    await removeOwnedDirectory(owned, hooks);
    return { failure, removed: true };
  } catch {
    return {
      failure:
        failure ??
        new PackagingError(
          "Plugin staging could not clean up its private artifact.",
        ),
      removed: false,
    };
  }
}

async function inspectOwnedVariant(
  path: string,
): Promise<OwnedDirectory | undefined> {
  const canonical = await inspectOwnedDirectory(path);
  const disposal = await inspectOwnedDirectory(disposalPath(path));
  if (canonical !== undefined && disposal !== undefined) {
    throw new PackagingError(
      "Plugin staging found conflicting private artifacts.",
    );
  }
  return canonical ?? disposal;
}

async function quarantineTransactionLock(
  target: TransactionTarget,
  lock: OwnedDirectory,
  token: string,
): Promise<boolean> {
  try {
    await quarantineOwnedDirectory(
      lock,
      join(target.parent, `.skizzles-package-${target.key}-cleanup-${token}`),
    );
    return true;
  } catch {
    return false;
  }
}

export type { CleanupOutcome, OwnedDirectory, RemovalHooks };
export {
  acquireLock,
  assertOwnedDirectory,
  cleanupOwned,
  createPrivateSibling,
  inspectOwnedDirectory,
  inspectOwnedVariant,
  quarantineOwnedDirectory,
  quarantineTransactionLock,
  readOwnedJson,
  removeOwnedDirectory,
  temporaryName,
  writeOwnedJson,
};
