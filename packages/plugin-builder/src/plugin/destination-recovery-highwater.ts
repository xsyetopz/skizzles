import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ClaimSnapshot } from "./destination-claim.ts";
import { readClaim, removeClaim } from "./destination-claim.ts";
import { UUID_PATTERN } from "./destination-journal.ts";
import { lockedDestinationError } from "./destination-parent.ts";
import type { TransactionTarget } from "./destination-path.ts";
import { transactionClaimPath } from "./destination-path.ts";
import {
  claimRetirementConfirmed,
  hasValidRetirementMarker,
  removeRetirementArtifacts,
} from "./destination-retirement.ts";

const GENERATION_PATTERN = /^[1-9][0-9]*$/u;
const HIGH_WATER_SEGMENT = ".recovery-highwater-";
// Canonical generation claims are never removed, so a suspended publisher can
// never reuse its chosen path. The cap bounds durable allocator state and
// deliberately fails closed after an operationally exceptional recovery count.
const MAX_RECOVERY_GENERATION = 4096;

interface ExistingRecoveryHighWater extends ClaimSnapshot {
  generation: number;
}

async function recoverRecoveryHighWaterTemps(
  target: TransactionTarget,
): Promise<void> {
  const legacyPrefix = `${basename(transactionClaimPath(target))}.recovery-`;
  const prefix = recoveryHighWaterPrefix(target);
  for (const name of (await readdir(target.parent)).sort()) {
    if (!(name.startsWith(prefix) && name.endsWith(".tmp"))) {
      if (name.startsWith(legacyPrefix) && name.endsWith(".tmp")) {
        throw lockedDestinationError();
      }
      continue;
    }
    const suffix = name.slice(prefix.length, -4);
    const markerTemp = parseRetirementMarkerTemp(suffix);
    if (markerTemp !== undefined) {
      const record = await readClaim(
        recoveryHighWaterPath(target, markerTemp.generation),
      );
      if (
        record === undefined ||
        record.owner.token !== markerTemp.token ||
        !(await claimRetirementConfirmed(record))
      ) {
        throw lockedDestinationError();
      }
      continue;
    }
    const separator = suffix.indexOf(".");
    const generation = suffix.slice(0, separator);
    const token = suffix.slice(separator + 1);
    const parsedGeneration = Number(generation);
    if (
      separator < 1 ||
      !GENERATION_PATTERN.test(generation) ||
      !Number.isSafeInteger(parsedGeneration) ||
      parsedGeneration > MAX_RECOVERY_GENERATION ||
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

async function inspectRecoveryHighWaters(
  target: TransactionTarget,
): Promise<ExistingRecoveryHighWater[]> {
  const legacyPrefix = `${basename(transactionClaimPath(target))}.recovery-`;
  const prefix = recoveryHighWaterPrefix(target);
  const records: ExistingRecoveryHighWater[] = [];
  for (const name of (await readdir(target.parent)).sort()) {
    if (!name.startsWith(prefix) || name.endsWith(".tmp")) {
      if (name.startsWith(legacyPrefix) && !name.endsWith(".tmp")) {
        throw lockedDestinationError();
      }
      continue;
    }
    const generationText = name.slice(prefix.length);
    const markerGeneration = parseRetirementMarker(generationText);
    if (markerGeneration !== undefined) {
      const record = await readClaim(
        recoveryHighWaterPath(target, markerGeneration),
      );
      if (record === undefined || !(await hasValidRetirementMarker(record))) {
        throw lockedDestinationError();
      }
      continue;
    }
    if (!GENERATION_PATTERN.test(generationText)) {
      throw lockedDestinationError();
    }
    const generation = Number(generationText);
    if (
      !Number.isSafeInteger(generation) ||
      generation > MAX_RECOVERY_GENERATION
    ) {
      throw lockedDestinationError();
    }
    const claim = await readClaim(join(target.parent, name));
    if (claim === undefined) throw lockedDestinationError();
    records.push({ ...claim, generation });
  }
  records.sort((left, right) => left.generation - right.generation);
  return records;
}

function parseRetirementMarker(value: string): number | undefined {
  const suffix = ".retired";
  if (!value.endsWith(suffix)) return;
  const generation = value.slice(0, -suffix.length);
  if (!GENERATION_PATTERN.test(generation)) return;
  const parsed = Number(generation);
  return Number.isSafeInteger(parsed) && parsed <= MAX_RECOVERY_GENERATION
    ? parsed
    : undefined;
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
  return Number.isSafeInteger(parsed) && parsed <= MAX_RECOVERY_GENERATION
    ? { generation: parsed, token }
    : undefined;
}

function recoveryHighWaterPath(
  target: TransactionTarget,
  generation: number,
): string {
  return `${transactionClaimPath(target)}${HIGH_WATER_SEGMENT}${generation}`;
}

function recoveryHighWaterPrefix(target: TransactionTarget): string {
  return `${basename(transactionClaimPath(target))}${HIGH_WATER_SEGMENT}`;
}

export type { ExistingRecoveryHighWater };
export {
  inspectRecoveryHighWaters,
  MAX_RECOVERY_GENERATION,
  recoverRecoveryHighWaterTemps,
  recoveryHighWaterPath,
};
