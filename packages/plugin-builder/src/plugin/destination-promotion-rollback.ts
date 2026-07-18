import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import type { OwnedDirectory } from "./destination-artifacts.ts";
import { assertOwnedDirectory, cleanupOwned } from "./destination-artifacts.ts";
import type {
  DestinationSnapshot,
  TransactionTarget,
} from "./destination-path.ts";
import { assertPathAbsent, assertPathIdentity } from "./destination-path.ts";

interface PromotionRollback {
  backup: OwnedDirectory | undefined;
  original: DestinationSnapshot;
  previousMoved: boolean;
  stage: OwnedDirectory;
  stageMoved: boolean;
  target: TransactionTarget;
}

async function rollbackOwnedPromotion(rollback: PromotionRollback) {
  const { backup, original, previousMoved, stage, stageMoved, target } =
    rollback;
  if (stageMoved) {
    await assertPathIdentity(target.destination, stage.identity);
    await rename(target.destination, stage.path);
    stage.present = true;
    await assertOwnedDirectory(stage, "private construction directory");
    await chmod(stage.path, 0o700);
    await assertOwnedDirectory(stage, "private construction directory");
  }
  if (previousMoved && backup !== undefined) {
    await assertPathAbsent(target.destination);
    const previous = join(backup.path, "previous");
    await assertPathIdentity(previous, original.identity);
    await rename(previous, target.destination);
  }
  const cleanup = await cleanupOwned(backup, undefined);
  if (!cleanup.removed) throw cleanup.failure;
}

export { rollbackOwnedPromotion };
