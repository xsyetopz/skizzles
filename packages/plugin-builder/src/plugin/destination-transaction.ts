import { rename } from "node:fs/promises";
import { join } from "node:path";
import { PackagingError } from "./contract.ts";
import type { OwnedDirectory } from "./destination-artifacts.ts";
import {
  acquireLock,
  assertOwnedDirectory,
  assertPathAbsent,
  assertPathIdentity,
  cleanupOwned,
  createPrivateSibling,
  removeOwnedDirectory,
} from "./destination-artifacts.ts";
import { ensureDestinationParent } from "./destination-parent.ts";
import type {
  DestinationSnapshot,
  TransactionTarget,
} from "./destination-path.ts";
import {
  assertDestinationUnchanged,
  inspectDestination,
  inspectTarget,
  revalidateAncestors,
} from "./destination-path.ts";

interface DestinationTransactionHooks {
  afterBackup?: () => Promise<void> | void;
}

interface PromotionRollback {
  backup: OwnedDirectory | undefined;
  original: DestinationSnapshot;
  previousPath: string | undefined;
  stage: OwnedDirectory;
  state: { previousMoved: boolean; stageMoved: boolean };
  target: TransactionTarget;
}

async function replaceDirectoryTransaction(
  destinationInput: string,
  construct: (privateRoot: string) => Promise<void>,
  hooks: DestinationTransactionHooks = {},
): Promise<void> {
  await ensureDestinationParent(destinationInput);
  const target = await inspectTarget(destinationInput);
  const lock = await acquireLock(target);
  let stage: OwnedDirectory | undefined;
  let failure: unknown;

  try {
    const destination = await inspectDestination(target.destination);
    stage = await createPrivateSibling(target, "stage");
    await construct(stage.path);
    await assertOwnedDirectory(stage, "private construction directory");
    await revalidateAncestors(target.ancestors);
    await assertDestinationUnchanged(target.destination, destination);
    await promote(target, destination, stage, hooks);
  } catch (error) {
    failure = error;
  }

  failure = await cleanupOwned(stage, failure);
  failure = await cleanupOwned(lock, failure);
  if (failure !== undefined) {
    throw failure;
  }
}

async function promote(
  target: TransactionTarget,
  original: DestinationSnapshot,
  stage: OwnedDirectory,
  hooks: DestinationTransactionHooks,
): Promise<void> {
  let backup: OwnedDirectory | undefined;
  let previousPath: string | undefined;
  if (original.present) {
    backup = await createPrivateSibling(target, "backup");
    previousPath = join(backup.path, "previous");
  }
  const state = { previousMoved: false, stageMoved: false };

  try {
    await preparePromotion(target, original, stage, backup);
    if (backup !== undefined && previousPath !== undefined) {
      await rename(target.destination, previousPath);
      state.previousMoved = true;
      await assertPathIdentity(previousPath, original.identity);
      await hooks.afterBackup?.();
    }
    await rename(stage.path, target.destination);
    stage.present = false;
    state.stageMoved = true;
    await assertPathIdentity(target.destination, stage.identity);
    if (backup !== undefined) {
      await removeOwnedDirectory(backup);
      state.previousMoved = false;
    }
  } catch (error) {
    await rollbackPromotion(
      {
        backup,
        original,
        previousPath,
        stage,
        state,
        target,
      },
      error,
    );
  }
}

async function preparePromotion(
  target: TransactionTarget,
  original: DestinationSnapshot,
  stage: OwnedDirectory,
  backup: OwnedDirectory | undefined,
): Promise<void> {
  await revalidateAncestors(target.ancestors);
  await assertDestinationUnchanged(target.destination, original);
  await assertOwnedDirectory(stage, "private construction directory");
  if (backup !== undefined) {
    await assertOwnedDirectory(backup, "private backup directory");
  }
}

async function rollbackPromotion(
  rollback: PromotionRollback,
  promotionError: unknown,
): Promise<never> {
  const { backup, original, previousPath, stage, state, target } = rollback;
  const replacementStarted = state.previousMoved || state.stageMoved;
  try {
    if (state.stageMoved) {
      await assertPathIdentity(target.destination, stage.identity);
      await rename(target.destination, stage.path);
      stage.present = true;
    }
    if (state.previousMoved && previousPath !== undefined) {
      await assertPathAbsent(target.destination);
      await assertPathIdentity(previousPath, original.identity);
      await rename(previousPath, target.destination);
      state.previousMoved = false;
    }
    if (backup !== undefined) {
      await removeOwnedDirectory(backup);
    }
  } catch (error) {
    throw new PackagingError(
      "Plugin staging promotion failed and rollback could not complete safely.",
      { cause: error },
    );
  }
  if (!replacementStarted && promotionError instanceof PackagingError) {
    throw promotionError;
  }
  if (!replacementStarted) {
    if (original.present) {
      throw new PackagingError(
        "Plugin staging promotion failed before destination replacement.",
        { cause: promotionError },
      );
    }
    throw new PackagingError(
      "Plugin staging promotion failed; the destination remains absent.",
      { cause: promotionError },
    );
  }
  if (original.present) {
    throw new PackagingError(
      "Plugin staging promotion failed; the previous destination was restored.",
    );
  }
  throw new PackagingError(
    "Plugin staging promotion failed; the destination remains absent.",
  );
}

export type { DestinationTransactionHooks };
export { replaceDirectoryTransaction };
