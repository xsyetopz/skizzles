import { rm } from "node:fs/promises";
import { safeStateName, writeJsonAtomic } from "../files.ts";
import {
  readTrustedDirectory,
  readTrustedUnknownJson,
} from "../trusted-filesystem.ts";
import type { LabMetadata } from "../types.ts";
import { assertLabMetadata } from "./lab-validation.ts";
import { labManifestPath, ownerKey, type StateRoots } from "./layout.ts";

export async function writeLab(
  roots: StateRoots,
  lab: LabMetadata,
): Promise<void> {
  assertLabMetadata(lab, roots, lab.owner, lab.id);
  await writeJsonAtomic(
    labManifestPath(roots.stateRoot, lab.owner, lab.id),
    lab,
  );
}

export async function readLab(
  roots: StateRoots,
  owner: string,
  labId: string,
): Promise<LabMetadata> {
  safeStateName(labId, "lab id");
  const value = await readTrustedUnknownJson(
    roots.stateRoot,
    ["owners", ownerKey(owner), "labs"],
    `${labId}.json`,
    "lab state file",
    { canonicalMismatch: "unsafe-indirection" },
  );
  assertLabMetadata(value, roots, owner, labId);
  return value;
}

export async function listLabs(
  roots: StateRoots,
  owner: string,
): Promise<LabMetadata[]> {
  const entries = await readTrustedDirectory(
    roots.stateRoot,
    ["owners", ownerKey(owner), "labs"],
    "lab state directory",
    { canonicalMismatch: "unsafe-indirection" },
  );
  if (!entries) {
    return [];
  }
  const labs: LabMetadata[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const name = entry.name;
    if (!name.endsWith(".json")) {
      throw new Error(`unexpected lab state entry: ${name}`);
    }
    if (!(entry.isFile() || entry.isSymbolicLink())) {
      throw new Error(`unexpected lab state entry: ${name}`);
    }
    labs.push(await readLab(roots, owner, name.slice(0, -5)));
  }
  return labs;
}

export async function removeLabState(
  stateRoot: string,
  owner: string,
  labId: string,
): Promise<void> {
  await rm(labManifestPath(stateRoot, owner, labId), { force: true });
}
