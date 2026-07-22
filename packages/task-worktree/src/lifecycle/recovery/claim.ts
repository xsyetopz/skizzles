import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { GitCommandAuthority } from "../../git/command.ts";
import {
  branchHead,
  exactChild,
  listWorktrees,
  pathExists,
  type RepositorySnapshot,
} from "../../git/repository.ts";
import { removeWritableRoot } from "../preparation/allocation.ts";

export interface AllocationClaim {
  readonly schema: "skizzles.task-worktree/allocation-claim";
}

interface ClaimBinding {
  readonly parent: string;
  readonly root: string;
  readonly marker: string;
  readonly worktreeRoot: string;
  readonly writableRoot: string;
  readonly branch: string;
  readonly git: GitCommandAuthority;
  readonly repository: RepositorySnapshot;
  readonly token: string;
  readonly device: bigint;
  readonly inode: bigint;
  allocationCreated: boolean;
  allocationUncertain: boolean;
  worktreeRemoved: boolean;
  writableRemoved: boolean;
  branchRemoved: boolean;
  released: boolean;
}

const claimBindings = new WeakMap<object, ClaimBinding>();

export async function acquireAllocationClaim(
  parent: string,
  worktreeRoot: string,
  writableRoot: string,
  branch: string,
  git: GitCommandAuthority,
  repository: RepositorySnapshot,
): Promise<AllocationClaim | undefined> {
  if (!(exactChild(parent, worktreeRoot) && exactChild(parent, writableRoot)))
    return;
  const claimRoot = join(parent, `${basename(worktreeRoot)}-claim`);
  if (!exactChild(parent, claimRoot)) return;
  try {
    await mkdir(claimRoot, { mode: 0o700 });
  } catch {
    return;
  }
  const token = randomBytes(32).toString("hex");
  const marker = join(claimRoot, "owner");
  try {
    await writeFile(marker, token, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const metadata = await lstat(claimRoot, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(claimRoot)) !== claimRoot
    ) {
      throw new Error("invalid allocation claim");
    }
    const claim: AllocationClaim = Object.freeze({
      schema: "skizzles.task-worktree/allocation-claim" as const,
    });
    claimBindings.set(claim, {
      parent,
      root: claimRoot,
      marker,
      worktreeRoot,
      writableRoot,
      branch,
      git,
      repository,
      token,
      device: metadata.dev,
      inode: metadata.ino,
      allocationCreated: false,
      allocationUncertain: false,
      worktreeRemoved: false,
      writableRemoved: false,
      branchRemoved: false,
      released: false,
    });
    return claim;
  } catch {
    await rm(claimRoot, { force: true, recursive: true }).catch(
      () => undefined,
    );
    return undefined;
  }
}

export function markAllocationCreated(claim: AllocationClaim): boolean {
  const binding = claimBindings.get(claim);
  if (
    binding === undefined ||
    binding.released ||
    binding.allocationCreated ||
    binding.allocationUncertain
  ) {
    return false;
  }
  binding.allocationCreated = true;
  return true;
}

export function markAllocationUncertain(claim: AllocationClaim): boolean {
  const binding = claimBindings.get(claim);
  if (
    binding === undefined ||
    binding.released ||
    binding.allocationCreated ||
    binding.allocationUncertain
  ) {
    return false;
  }
  binding.allocationUncertain = true;
  return true;
}

export async function releaseAllocationClaim(
  claim: AllocationClaim,
): Promise<boolean> {
  const binding = claimBindings.get(claim);
  if (binding === undefined || binding.released) return false;
  if (!(await claimIsIntact(binding))) return false;
  try {
    await rm(binding.root, { recursive: true });
    if (await pathExists(binding.root)) return false;
    binding.released = true;
    return true;
  } catch {
    return false;
  }
}

export async function cleanupFailedAllocation(
  claim: AllocationClaim,
): Promise<boolean> {
  const binding = claimBindings.get(claim);
  if (
    binding === undefined ||
    binding.released ||
    !(await claimIsIntact(binding))
  ) {
    return false;
  }
  if (binding.allocationUncertain) {
    return await cleanupUncertainAllocation(claim, binding);
  }
  if (!binding.allocationCreated) {
    return await releaseAllocationClaim(claim);
  }
  if (!(await removeOwnedWorktree(binding))) return false;
  if (!(await removeOwnedBranch(binding))) return false;
  if (
    !(
      binding.writableRemoved ||
      (await removeWritableRoot(binding.parent, binding.writableRoot))
    )
  ) {
    return false;
  }
  binding.writableRemoved = true;
  return await releaseAllocationClaim(claim);
}

async function cleanupUncertainAllocation(
  claim: AllocationClaim,
  binding: ClaimBinding,
): Promise<boolean> {
  const entries = await listWorktrees(binding.git, binding.repository.root);
  const head = await branchHead(
    binding.git,
    binding.repository.root,
    binding.branch,
  );
  if (
    entries === undefined ||
    head === undefined ||
    head !== null ||
    entries.some(
      (entry) =>
        entry.root === binding.worktreeRoot || entry.branch === binding.branch,
    ) ||
    (await pathExists(binding.worktreeRoot)) ||
    (await pathExists(binding.writableRoot))
  ) {
    return false;
  }
  return await releaseAllocationClaim(claim);
}

async function removeOwnedWorktree(binding: ClaimBinding): Promise<boolean> {
  if (binding.worktreeRemoved) return true;
  const entries = await listWorktrees(binding.git, binding.repository.root);
  if (entries === undefined) return false;
  const atRoot = entries.filter((entry) => entry.root === binding.worktreeRoot);
  if (
    atRoot.some(
      (entry) =>
        entry.branch !== binding.branch ||
        entry.head !== binding.repository.head,
    )
  ) {
    return false;
  }
  if (atRoot.length > 0) {
    await binding.git.run(binding.repository.root, [
      "worktree",
      "remove",
      "--force",
      "--",
      binding.worktreeRoot,
    ]);
  }
  const remaining = await listWorktrees(binding.git, binding.repository.root);
  if (
    remaining === undefined ||
    remaining.some((entry) => entry.root === binding.worktreeRoot) ||
    (await pathExists(binding.worktreeRoot))
  ) {
    return false;
  }
  binding.worktreeRemoved = true;
  return true;
}

async function removeOwnedBranch(binding: ClaimBinding): Promise<boolean> {
  if (binding.branchRemoved) return true;
  const head = await branchHead(
    binding.git,
    binding.repository.root,
    binding.branch,
  );
  if (
    head === undefined ||
    (head !== null && head !== binding.repository.head)
  ) {
    return false;
  }
  if (head !== null) {
    const remaining = await listWorktrees(binding.git, binding.repository.root);
    if (
      remaining === undefined ||
      remaining.some((entry) => entry.branch === binding.branch)
    ) {
      return false;
    }
    await binding.git.run(binding.repository.root, [
      "branch",
      "-D",
      "--",
      binding.branch,
    ]);
  }
  if (
    (await branchHead(binding.git, binding.repository.root, binding.branch)) !==
    null
  ) {
    return false;
  }
  binding.branchRemoved = true;
  return true;
}

async function claimIsIntact(binding: ClaimBinding): Promise<boolean> {
  if (!exactChild(binding.parent, binding.root)) return false;
  try {
    const metadata = await lstat(binding.root, { bigint: true });
    return (
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      metadata.dev === binding.device &&
      metadata.ino === binding.inode &&
      (await realpath(binding.root)) === binding.root &&
      (await readFile(binding.marker, "utf8")) === binding.token
    );
  } catch {
    return false;
  }
}
