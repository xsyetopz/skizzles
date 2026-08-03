import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { readJson, safeStateName, writeJsonAtomic } from "./files";
import {
  assertLabMetadata,
  isRecord,
  isTimestamp,
  realDirectory,
  realDirectoryInside,
  realFileInside,
} from "./state-validation";
import type { LabMetadata, OwnerManifest, PersistedLabRuntime } from "./records";

export type StateRoots = { stateRoot: string; runtimeRoot: string };
export type Clock = () => Date;
export const DEFAULT_LAB_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export type ReapedOwnerManifest = {
  version: 1;
  owner: string;
  ownerKey: string;
  reapedAt: string;
};

export function defaultStateRoot(): string {
  return join(homedir(), "Library", "Application Support", "OpenAI", "codex-container-lab");
}

export function defaultRuntimeRoot(): string {
  return join(tmpdir(), "codex-container-lab");
}

export function resolveRoots(options: { stateRoot?: string; runtimeRoot?: string } = {}): StateRoots {
  return {
    stateRoot: resolve(options.stateRoot ?? process.env.CODEX_CONTAINER_LAB_STATE_ROOT ?? defaultStateRoot()),
    runtimeRoot: resolve(options.runtimeRoot ?? process.env.CODEX_CONTAINER_LAB_RUNTIME_ROOT ?? defaultRuntimeRoot()),
  };
}

export function resolveOwner(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  const owner = explicit ?? environment.CODEX_THREAD_ID;
  if (owner === undefined || owner.length === 0) {
    throw new Error("owner is required: pass --owner THREAD_ID or set CODEX_THREAD_ID");
  }
  if (owner.includes("\0")) throw new Error("owner must not contain NUL");
  if (Buffer.byteLength(owner, "utf8") > 4096) throw new Error("owner must be at most 4096 UTF-8 bytes");
  return owner;
}

export function ownerKey(owner: string): string {
  return createHash("sha256").update(owner).digest("hex");
}

export function ownerDirectory(stateRoot: string, owner: string): string {
  return join(stateRoot, "owners", ownerKey(owner));
}

export function ownerRuntimeDirectory(runtimeRoot: string, owner: string): string {
  return join(runtimeRoot, ownerKey(owner));
}

export function ownerManifestPath(stateRoot: string, owner: string): string {
  return join(ownerDirectory(stateRoot, owner), "owner.json");
}

export function ownerLockPath(stateRoot: string, owner: string): string {
  return join(stateRoot, ".locks", `owner-${ownerKey(owner)}`);
}

export function reapedOwnerPath(stateRoot: string, owner: string): string {
  return join(stateRoot, "reaped", `${ownerKey(owner)}.json`);
}

export async function readReapedOwner(stateRoot: string, owner: string): Promise<ReapedOwnerManifest | undefined> {
  let value: unknown;
  try { value = await readJson<unknown>(reapedOwnerPath(stateRoot, owner)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!isRecord(value) || value.version !== 1 || value.owner !== owner || value.ownerKey !== ownerKey(owner) ||
      !isTimestamp(value.reapedAt)) {
    throw new Error("invalid reaped owner manifest");
  }
  return value as ReapedOwnerManifest;
}

export async function markOwnerReaped(stateRoot: string, owner: string): Promise<ReapedOwnerManifest> {
  const existing = await readReapedOwner(stateRoot, owner);
  if (existing) return existing;
  const manifest: ReapedOwnerManifest = {
    version: 1,
    owner,
    ownerKey: ownerKey(owner),
    reapedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(reapedOwnerPath(stateRoot, owner), manifest);
  return manifest;
}

export function labsDirectory(stateRoot: string, owner: string): string {
  return join(ownerDirectory(stateRoot, owner), "labs");
}

export function labManifestPath(stateRoot: string, owner: string, labId: string): string {
  safeStateName(labId, "lab id");
  return join(labsDirectory(stateRoot, owner), `${labId}.json`);
}

export function expectedLabRuntimeRoot(roots: StateRoots, owner: string, labId: string): string {
  safeStateName(labId, "lab id");
  return join(resolve(roots.runtimeRoot), ownerKey(owner), labId);
}

export async function ensureOwner(stateRoot: string, owner: string): Promise<OwnerManifest> {
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  const value = await readJson<unknown>(path);
  if (!isRecord(value) || value.version !== 1 || typeof value.owner !== "string" ||
      typeof value.ownerKey !== "string" || !isTimestamp(value.createdAt)) {
    throw new Error(`invalid owner manifest: ${path}`);
  }
  resolveOwner(value.owner, {});
  if (value.ownerKey !== ownerKey(value.owner) || basename(resolve(path, "..")) !== value.ownerKey) {
    throw new Error(`owner manifest hash mismatch: ${path}`);
  }
  return value as OwnerManifest;
}

export async function listOwnerManifests(stateRoot: string): Promise<Array<{ directory: string; manifest: OwnerManifest }>> {
  const root = join(stateRoot, "owners");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const owners: Array<{ directory: string; manifest: OwnerManifest }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error(`unexpected owner state entry: ${entry.name}`);
    const directory = join(root, entry.name);
    const manifest = await readOwnerManifest(join(directory, "owner.json"));
    owners.push({ directory, manifest });
  }
  return owners;
}

export async function writeLab(roots: StateRoots, lab: LabMetadata): Promise<void> {
  assertLabMetadata(lab, roots, lab.owner, lab.id);
  await writeJsonAtomic(labManifestPath(roots.stateRoot, lab.owner, lab.id), lab);
}

/** Update a validated lab lease. Callers must hold the lab activity lock. */
export async function refreshLabActivity(
  roots: StateRoots,
  owner: string,
  labId: string,
  clock: Clock = () => new Date(),
): Promise<LabMetadata> {
  const lab = await readLab(roots, owner, labId);
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("clock returned an invalid date");
  const timestamp = now.toISOString();
  lab.lastActivityAt = timestamp;
  lab.updatedAt = timestamp;
  await writeLab(roots, lab);
  return lab;
}

export async function readLab(roots: StateRoots, owner: string, labId: string): Promise<LabMetadata> {
  const value = await readJson<unknown>(labManifestPath(roots.stateRoot, owner, labId));
  assertLabMetadata(value, roots, owner, labId);
  return value;
}

export async function listLabs(roots: StateRoots, owner: string): Promise<LabMetadata[]> {
  const directory = labsDirectory(roots.stateRoot, owner);
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const labs: LabMetadata[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) throw new Error(`unexpected lab state entry: ${name}`);
    labs.push(await readLab(roots, owner, name.slice(0, -5)));
  }
  return labs;
}

export async function removeLabState(stateRoot: string, owner: string, labId: string): Promise<void> {
  await rm(labManifestPath(stateRoot, owner, labId), { force: true });
}

export async function assertReadyLabFilesystem(roots: StateRoots, lab: LabMetadata): Promise<void> {
  if (lab.state !== "ready" || !lab.runtime) throw new Error(`lab is not ready: ${lab.state}`);
  const configuredRuntime = await realDirectory(roots.runtimeRoot, "configured runtime root");
  const ownerRuntime = await realDirectory(join(roots.runtimeRoot, lab.ownerKey), "owner runtime root");
  const runtime = await realDirectory(lab.runtimeRoot, "lab runtime root");
  const workspace = await realDirectory(lab.workspace, "lab workspace");
  if (ownerRuntime !== join(configuredRuntime, lab.ownerKey) || runtime !== join(ownerRuntime, lab.id) || workspace !== join(runtime, "workspace")) {
    throw new Error("runtime or workspace resolved outside the configured runtime root");
  }
  const source = await realDirectory(lab.sourceRoot, "lab source root");
  await realFileInside(source, lab.manifestPath, "lab manifest");
  await realFileInside(runtime, lab.runtime.overrideFile, "Compose override");
  if (lab.runtime.baseFile) await realFileInside(runtime, lab.runtime.baseFile, "internal Compose base");
  const mode = lab.runtime.config.mode;
  if (mode.kind === "compose") {
    for (const path of mode.files) await realFileInside(source, path, "project Compose file");
  } else if (mode.kind === "dockerfile") {
    await realFileInside(source, mode.dockerfile, "project Dockerfile");
    await realDirectoryInside(source, mode.context, "Dockerfile context");
  }
}
