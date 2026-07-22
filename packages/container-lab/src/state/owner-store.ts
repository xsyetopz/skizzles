import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { writeJsonAtomic } from "../files.ts";
import {
  readTrustedDirectory,
  readTrustedUnknownJson,
} from "../trusted-filesystem.ts";
import type { OwnerManifest } from "./lab/contract.ts";
import {
  ownerDirectory,
  ownerKey,
  ownerManifestPath,
  reapedOwnerPath,
  resolveOwner,
} from "./layout.ts";

export type ReapedOwnerManifest = {
  version: 1;
  owner: string;
  ownerKey: string;
  reapedAt: string;
};

export async function readReapedOwner(
  stateRoot: string,
  owner: string,
): Promise<ReapedOwnerManifest | undefined> {
  let value: unknown;
  try {
    value = await readTrustedUnknownJson(
      stateRoot,
      ["reaped"],
      `${ownerKey(owner)}.json`,
      "reaped owner marker",
      { canonicalMismatch: "unsafe-indirection" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    value["owner"] !== owner ||
    value["ownerKey"] !== ownerKey(owner) ||
    !isTimestamp(value["reapedAt"])
  ) {
    throw new Error("invalid reaped owner manifest");
  }
  return {
    version: 1,
    owner: value["owner"],
    ownerKey: value["ownerKey"],
    reapedAt: value["reapedAt"],
  };
}

export async function markOwnerReaped(
  stateRoot: string,
  owner: string,
): Promise<ReapedOwnerManifest> {
  const existing = await readReapedOwner(stateRoot, owner);
  if (existing) {
    return existing;
  }
  const manifest: ReapedOwnerManifest = {
    version: 1,
    owner,
    ownerKey: ownerKey(owner),
    reapedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(reapedOwnerPath(stateRoot, owner), manifest);
  return manifest;
}

export async function ensureOwner(
  stateRoot: string,
  owner: string,
): Promise<OwnerManifest> {
  resolveOwner(owner, {});
  const directory = ownerDirectory(stateRoot, owner);
  await mkdir(join(directory, "labs"), { recursive: true, mode: 0o700 });
  const path = ownerManifestPath(stateRoot, owner);
  try {
    const existing = await readOwnerManifest(path);
    if (existing.owner !== owner || existing.ownerKey !== ownerKey(owner)) {
      throw new Error("owner hash collision or mismatched owner manifest");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const manifest: OwnerManifest = {
    version: 1,
    owner,
    ownerKey: ownerKey(owner),
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path, manifest);
  return manifest;
}

export async function readOwnerManifest(path: string): Promise<OwnerManifest> {
  const resolvedPath = resolve(path);
  const directory = resolve(resolvedPath, "..");
  const key = basename(directory);
  const owners = resolve(directory, "..");
  if (
    basename(resolvedPath) !== "owner.json" ||
    basename(owners) !== "owners"
  ) {
    throw new Error(`invalid owner manifest path: ${path}`);
  }
  const stateRoot = resolve(owners, "..");
  const value = await readTrustedUnknownJson(
    stateRoot,
    ["owners", key],
    "owner.json",
    "owner manifest",
    { canonicalMismatch: "unsafe-indirection" },
  );
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    typeof value["owner"] !== "string" ||
    typeof value["ownerKey"] !== "string" ||
    !isTimestamp(value["createdAt"])
  ) {
    throw new Error(`invalid owner manifest: ${path}`);
  }
  resolveOwner(value["owner"], {});
  if (
    value["ownerKey"] !== ownerKey(value["owner"]) ||
    basename(resolve(path, "..")) !== value["ownerKey"]
  ) {
    throw new Error(`owner manifest hash mismatch: ${path}`);
  }
  return {
    version: 1,
    owner: value["owner"],
    ownerKey: value["ownerKey"],
    createdAt: value["createdAt"],
  };
}

export async function listOwnerManifests(
  stateRoot: string,
): Promise<Array<{ directory: string; manifest: OwnerManifest }>> {
  const root = join(stateRoot, "owners");
  const entries = await readTrustedDirectory(
    stateRoot,
    ["owners"],
    "owners state directory",
    { canonicalMismatch: "unsafe-indirection" },
  );
  if (!entries) {
    return [];
  }
  const owners: Array<{ directory: string; manifest: OwnerManifest }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new Error(`unexpected owner state entry: ${entry.name}`);
    }
    const directory = join(root, entry.name);
    const manifest = await readOwnerManifest(join(directory, "owner.json"));
    owners.push({ directory, manifest });
  }
  return owners;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
