import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { safeStateName } from "../files.ts";

export type StateRoots = { stateRoot: string; runtimeRoot: string };

export function defaultStateRoot(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "OpenAI",
    "codex-container-lab",
  );
}

export function defaultRuntimeRoot(): string {
  return join(tmpdir(), "codex-container-lab");
}

export function resolveRoots(
  options: { stateRoot?: string; runtimeRoot?: string } = {},
): StateRoots {
  return {
    stateRoot: resolve(
      options.stateRoot ??
        process.env["CODEX_CONTAINER_LAB_STATE_ROOT"] ??
        defaultStateRoot(),
    ),
    runtimeRoot: resolve(
      options.runtimeRoot ??
        process.env["CODEX_CONTAINER_LAB_RUNTIME_ROOT"] ??
        defaultRuntimeRoot(),
    ),
  };
}

export function resolveOwner(
  explicit?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const owner = explicit ?? environment["CODEX_THREAD_ID"];
  if (owner === undefined || owner.length === 0) {
    throw new Error(
      "owner is required: pass --owner THREAD_ID or set CODEX_THREAD_ID",
    );
  }
  if (owner.includes("\0")) {
    throw new Error("owner must not contain NUL");
  }
  if (Buffer.byteLength(owner, "utf8") > 4096) {
    throw new Error("owner must be at most 4096 UTF-8 bytes");
  }
  return owner;
}

export function ownerKey(owner: string): string {
  return createHash("sha256").update(owner).digest("hex");
}

export function ownerDirectory(stateRoot: string, owner: string): string {
  return join(stateRoot, "owners", ownerKey(owner));
}

export function ownerRuntimeDirectory(
  runtimeRoot: string,
  owner: string,
): string {
  return join(runtimeRoot, ownerKey(owner));
}

export function ownerManifestPath(stateRoot: string, owner: string): string {
  return join(ownerDirectory(stateRoot, owner), "owner.json");
}

export function ownerLockPath(stateRoot: string, owner: string): string {
  return join(stateRoot, ".locks", `owner-${ownerKey(owner)}`);
}

export function labLockPath(
  stateRoot: string,
  owner: string,
  labId: string,
): string {
  safeStateName(labId, "lab id");
  return join(ownerDirectory(stateRoot, owner), ".locks", `lab-${labId}`);
}

export function activityLockPath(
  stateRoot: string,
  owner: string,
  labId: string,
): string {
  safeStateName(labId, "lab id");
  return join(ownerDirectory(stateRoot, owner), ".locks", `activity-${labId}`);
}

export function reapedOwnerPath(stateRoot: string, owner: string): string {
  return join(stateRoot, "reaped", `${ownerKey(owner)}.json`);
}

export function labsDirectory(stateRoot: string, owner: string): string {
  return join(ownerDirectory(stateRoot, owner), "labs");
}

export function labManifestPath(
  stateRoot: string,
  owner: string,
  labId: string,
): string {
  safeStateName(labId, "lab id");
  return join(labsDirectory(stateRoot, owner), `${labId}.json`);
}

export function expectedLabRuntimeRoot(
  roots: StateRoots,
  owner: string,
  labId: string,
): string {
  safeStateName(labId, "lab id");
  return join(resolve(roots.runtimeRoot), ownerKey(owner), labId);
}
