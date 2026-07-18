import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  canonicalRoot,
  guardedPath,
  readUnknownJson,
  safeStateName,
} from "./files.ts";
import type { SyncIdentity } from "./sync-contract.ts";

export interface SyncStatePaths {
  root: string;
  previews: string;
  used: string;
  journals: string;
  backups: string;
  baseline: string;
}

export async function syncStatePaths(
  identity: Pick<SyncIdentity, "stateRoot" | "labId">,
): Promise<SyncStatePaths> {
  safeStateName(identity.labId, "lab id");
  await mkdir(identity.stateRoot, { recursive: true, mode: 0o700 });
  const stateRoot = await canonicalRoot(identity.stateRoot);
  const root = path.join(stateRoot, "sync", identity.labId);
  const previews = path.join(root, "previews");
  const used = path.join(root, "used");
  const journals = path.join(root, "journals");
  const backups = path.join(root, "backups");
  for (const relative of [
    "sync",
    `sync/${identity.labId}`,
    `sync/${identity.labId}/previews`,
    `sync/${identity.labId}/used`,
    `sync/${identity.labId}/journals`,
    `sync/${identity.labId}/backups`,
  ]) {
    await ensureStateDirectory(stateRoot, relative);
  }
  return {
    root,
    previews,
    used,
    journals,
    backups,
    baseline: path.join(root, "baseline.json"),
  };
}

async function ensureStateDirectory(
  stateRoot: string,
  relative: string,
): Promise<void> {
  const directory = await guardedPath(stateRoot, relative, true);
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe synchronization state directory: ${relative}`);
  }
}

export async function readRequiredUnknownJson(
  file: string,
  message: string,
): Promise<unknown> {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Unsafe synchronization state file");
    }
    return await readUnknownJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(message);
    }
    throw error;
  }
}
