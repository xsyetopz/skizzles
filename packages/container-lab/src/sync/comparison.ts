import { describeSyncFile, type SyncFile } from "../files.ts";
import type { SyncChange, SyncComparison, SyncConflict } from "./contract.ts";

export function sameSyncFile(a?: SyncFile, b?: SyncFile): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return (
    a.kind === b.kind &&
    a.sha256 === b.sha256 &&
    a.size === b.size &&
    a.mode === b.mode
  );
}

export async function assertExpectedEntry(
  root: string,
  relative: string,
  expected: SyncFile | null,
  side: string,
): Promise<void> {
  let actual: SyncFile | null = null;
  try {
    actual = await describeSyncFile(root, relative);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (!sameSyncFile(actual ?? undefined, expected ?? undefined)) {
    throw new Error(
      `Synchronization ${side} changed after preview: ${relative}`,
    );
  }
}

export function compareManifests(
  baseline: Record<string, SyncFile>,
  source: Record<string, SyncFile>,
  target: Record<string, SyncFile>,
): SyncComparison {
  const changes: SyncChange[] = [];
  const conflicts: SyncConflict[] = [];
  const names = new Set([
    ...Object.keys(baseline),
    ...Object.keys(source),
    ...Object.keys(target),
  ]);
  for (const name of [...names].sort()) {
    const result = compareManifestPath(
      name,
      baseline[name],
      source[name],
      target[name],
    );
    if (result.change) {
      changes.push(result.change);
    }
    if (result.conflict) {
      conflicts.push(result.conflict);
    }
  }
  return { changes, conflicts };
}

function compareManifestPath(
  name: string,
  before?: SyncFile,
  from?: SyncFile,
  to?: SyncFile,
): { change?: SyncChange; conflict?: SyncConflict } {
  if (sameSyncFile(from, to)) {
    return {};
  }
  const sourceChanged = !sameSyncFile(from, before);
  if (!sourceChanged) {
    return {};
  }
  if (!sameSyncFile(to, before)) {
    return {
      conflict: {
        path: name,
        ...(before === undefined ? {} : { baseline: before }),
        ...(from === undefined ? {} : { source: from }),
        ...(to === undefined ? {} : { target: to }),
      },
    };
  }
  return {
    change: from
      ? { path: name, action: "upsert", file: from }
      : { path: name, action: "delete" },
  };
}
