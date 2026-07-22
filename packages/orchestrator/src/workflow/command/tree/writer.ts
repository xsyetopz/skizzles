import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  RunWorkspace,
  WorkspaceUsageLimits,
} from "@skizzles/run-workspace";
import { identity, privateDirectory, sameIdentity } from "../identity.ts";
import { type MutableStage, validRelativePath, withinQuota } from "./state.ts";

interface DirectoryInput {
  readonly root: string;
  readonly parts: readonly string[];
  readonly stage: MutableStage;
  readonly workspace: RunWorkspace;
  readonly limits: WorkspaceUsageLimits;
}

export async function ensureOwnedDirectories(
  input: DirectoryInput,
): Promise<boolean> {
  let path = "";
  for (const part of input.parts) {
    if (!validRelativePath(part)) return false;
    path = path === "" ? part : `${path}/${part}`;
    const absolute = join(input.root, path);
    const current = await optionalLstat(absolute);
    if (current !== undefined) {
      const tracked = input.stage.directories.get(path);
      if (
        !privateDirectory(current) ||
        (tracked !== undefined && !sameIdentity(current, tracked.identity))
      ) {
        return false;
      }
    } else {
      await mkdir(absolute, { mode: 0o700, recursive: false });
      const created = await lstat(absolute, { bigint: true });
      if (!privateDirectory(created)) return false;
      input.stage.directories.set(
        path,
        Object.freeze({ path, identity: identity(created) }),
      );
      if (!(await withinQuota(input.workspace, input.limits))) return false;
    }
  }
  return true;
}

export async function createInternalLink(input: {
  readonly root: string;
  readonly path: string;
  readonly resolvedPath: string;
  readonly stage: MutableStage;
  readonly workspace: RunWorkspace;
  readonly limits: WorkspaceUsageLimits;
}): Promise<boolean> {
  const parts = input.path.split("/");
  if (
    !validRelativePath(input.path) ||
    !(await ensureOwnedDirectories({ ...input, parts: parts.slice(0, -1) }))
  ) {
    return false;
  }
  const rootReal = await realpath(input.root);
  const expected = await realpath(input.resolvedPath);
  if (!withinRoot(rootReal, expected)) return false;
  const linkPath = join(input.root, ...parts);
  if ((await optionalLstat(linkPath)) !== undefined) return false;
  const target = relative(dirname(linkPath), expected);
  if (target === "" || resolve(dirname(linkPath), target) !== expected) {
    return false;
  }
  await symlink(target, linkPath, "dir");
  const stat = await lstat(linkPath, { bigint: true });
  if (
    !ownedLink(stat) ||
    (await readlink(linkPath)) !== target ||
    (await realpath(linkPath)) !== expected
  ) {
    return false;
  }
  input.stage.links.set(
    input.path,
    Object.freeze({
      path: input.path,
      identity: identity(stat),
      target,
      resolvedPath: expected,
    }),
  );
  return withinQuota(input.workspace, input.limits);
}

function ownedLink(stat: BigIntStats): boolean {
  return stat.isSymbolicLink() && stat.nlink === 1n;
}

async function optionalLstat(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
}

function withinRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function hasCode(error: unknown, expected: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === expected
  );
}
