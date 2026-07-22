import { lstat, realpath, rm } from "node:fs/promises";
import type { TaskWorktreePrepareInput } from "../contract.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import type { GitCommandAuthority } from "../git/command.ts";
import {
  branchHead,
  exactChild,
  isOutside,
  listWorktrees,
  pathExists,
  plainDirectory,
  type RepositorySnapshot,
} from "../git/repository.ts";

export function allocationFor(
  input: TaskWorktreePrepareInput,
): Readonly<{ branch: string; leaf: string }> {
  const normalized = input.taskId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
  const digest = digestTaskWorktreeValue({
    taskId: input.taskId,
    taskEpochDigest: input.taskEpochDigest,
    repositoryId: input.repositoryId,
    rootIdentity: input.rootIdentity,
  }).slice("sha256:".length, "sha256:".length + 16);
  return Object.freeze({
    branch: `codex/task-${normalized}-${digest}`,
    leaf: `task-${normalized}-${digest}`,
  });
}

export async function validateAllocationParent(
  configuredParent: string,
  repositoryRoot: string,
): Promise<string | undefined> {
  if (!(await plainDirectory(configuredParent))) {
    return;
  }
  try {
    const parent = await realpath(configuredParent);
    return isOutside(parent, repositoryRoot) ? parent : undefined;
  } catch {
    return;
  }
}

export async function verifyAllocation(
  git: GitCommandAuthority,
  repository: RepositorySnapshot,
  worktreeRoot: string,
  branch: string,
  expectedHead: string,
): Promise<boolean> {
  if (!(await plainDirectory(worktreeRoot))) {
    return false;
  }
  try {
    if ((await realpath(worktreeRoot)) !== worktreeRoot) {
      return false;
    }
  } catch {
    return false;
  }
  const entries = await listWorktrees(git, repository.root);
  const head = await branchHead(git, repository.root, branch);
  return (
    entries !== undefined &&
    head === expectedHead &&
    entries.some(
      (entry) =>
        entry.root === worktreeRoot &&
        entry.branch === branch &&
        entry.head === expectedHead,
    )
  );
}

export async function removeWritableRoot(
  parent: string,
  writableRoot: string,
): Promise<boolean> {
  try {
    const canonicalParent = await realpath(parent);
    if (!exactChild(canonicalParent, writableRoot)) {
      return false;
    }
    const metadata = await lstat(writableRoot);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(writableRoot)) !== writableRoot
    ) {
      return false;
    }
    await rm(writableRoot, { recursive: true });
    return !(await pathExists(writableRoot));
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}
