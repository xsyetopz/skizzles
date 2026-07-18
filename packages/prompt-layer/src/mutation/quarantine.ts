import type { Dirent } from "node:fs";
import { lstat, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProcessIdentityProvider } from "../lifecycle-contract.ts";
import {
  LOCK_OWNER_PATH,
  LOCK_PATH,
  PROMPT_LAYER_ASSET_ROOT,
  PromptLayerError,
} from "../lifecycle-contract.ts";
import {
  assertContainedPath,
  assertFilesystemIdentity,
  type FileIdentity,
  fileIdentity,
  pathExists,
  removeOwnedTree,
  syncDirectory,
} from "../repository-boundary.ts";
import { processOwnerState } from "./process-identity.ts";
import type { MutationLockOwner } from "./protocol.ts";
import { readMutationOwner, TOKEN } from "./protocol.ts";

export async function cleanupMutationOrphans(
  root: string,
  provider: ProcessIdentityProvider,
  write: boolean,
): Promise<void> {
  const layerPath = join(root, PROMPT_LAYER_ASSET_ROOT);
  const entries = await readdir(layerPath, { withFileTypes: true });
  for (const entry of entries) {
    const kind = mutationOrphanKind(entry.name);
    if (kind === undefined) {
      continue;
    }
    await cleanupMutationOrphan(root, entry, kind, provider, write);
  }
}

function mutationOrphanKind(name: string): "stale" | "release" | undefined {
  if (name.startsWith(".mutation-stale-")) {
    return "stale";
  }
  if (name.startsWith(".mutation-release-")) {
    return "release";
  }
  return undefined;
}

async function cleanupMutationOrphan(
  root: string,
  entry: Dirent,
  kind: "stale" | "release",
  provider: ProcessIdentityProvider,
  write: boolean,
): Promise<void> {
  const prefix = `.mutation-${kind}-`;
  const token = entry.name.slice(prefix.length);
  if (!TOKEN.test(token)) {
    throw new PromptLayerError(
      `Malformed prompt mutation ${kind} quarantine ${entry.name}; refusing cleanup.`,
    );
  }
  const relativePath = `${PROMPT_LAYER_ASSET_ROOT}/${entry.name}`;
  await assertContainedPath(root, relativePath, true);
  const absolute = join(root, relativePath);
  const metadata = await lstat(absolute);
  if (!entry.isDirectory() || metadata.isSymbolicLink()) {
    throw new PromptLayerError(
      `Prompt mutation ${kind} quarantine ${entry.name} is not a safe directory.`,
    );
  }
  const identity = fileIdentity(metadata);
  const owner = await readMutationOwner(root, `${relativePath}/owner.json`);
  if (owner.token !== token) {
    throw new PromptLayerError(
      `Prompt mutation ${kind} quarantine ${entry.name} does not match its owner token.`,
    );
  }
  const state = await processOwnerState(owner, provider);
  if (state !== "stale") {
    const detail = state === "live" ? "live" : "unverifiable";
    throw new PromptLayerError(
      `Prompt mutation ${kind} quarantine ${entry.name} has a ${detail} owner; refusing cleanup.`,
    );
  }
  if (!write) {
    throw new PromptLayerError(
      `A recoverable prompt mutation ${kind} quarantine is pending; prompt:check refuses to write or recover it.`,
    );
  }
  await removeOwnedTree(root, relativePath, identity);
}

export async function removeOwnedLockDirectory(
  root: string,
  identity: FileIdentity,
  token: string,
): Promise<void> {
  const absolute = join(root, LOCK_PATH);
  try {
    await assertFilesystemIdentity(
      absolute,
      identity,
      "Prompt mutation lock changed before failed-initialization cleanup.",
    );
  } catch {
    return;
  }
  if (await pathExists(join(root, LOCK_OWNER_PATH))) {
    let owner: MutationLockOwner;
    try {
      owner = await readMutationOwner(root, LOCK_OWNER_PATH);
    } catch {
      return;
    }
    if (owner.token !== token) {
      return;
    }
  }
  const quarantine = `${PROMPT_LAYER_ASSET_ROOT}/.mutation-release-${token}`;
  if (await pathExists(join(root, quarantine))) {
    return;
  }
  await assertContainedPath(root, quarantine, false);
  await assertFilesystemIdentity(
    absolute,
    identity,
    "Prompt mutation lock changed before failed-initialization quarantine.",
  );
  await rename(absolute, join(root, quarantine));
  await syncDirectory(dirname(absolute));
  await removeOwnedTree(root, quarantine, identity);
}
