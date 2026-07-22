import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GitCommandAuthority } from "./command.ts";

export interface RepositorySnapshot {
  readonly root: string;
  readonly commonDirectory: string;
  readonly head: string;
}

export interface RegisteredWorktree {
  readonly root: string;
  readonly head: string;
  readonly branch: string | null;
}

const objectIdPattern = /^[0-9a-f]{40,64}$/u;

export async function captureRepository(
  git: GitCommandAuthority,
  configuredRoot: string,
): Promise<RepositorySnapshot | undefined> {
  if (!(await plainDirectory(configuredRoot))) return;
  let root: string;
  try {
    root = await realpath(configuredRoot);
  } catch {
    return;
  }
  const top = await git.run(root, ["rev-parse", "--show-toplevel"]);
  const common = await git.run(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const head = await git.run(root, ["rev-parse", "--verify", "HEAD"]);
  if (!(top && common && head)) return;
  const reportedRoot = singleLine(top.stdout);
  const commonDirectory = singleLine(common.stdout);
  const headId = singleLine(head.stdout);
  if (
    reportedRoot === undefined ||
    commonDirectory === undefined ||
    headId === undefined ||
    !isAbsolute(reportedRoot) ||
    !isAbsolute(commonDirectory) ||
    !objectIdPattern.test(headId)
  ) {
    return;
  }
  try {
    if ((await realpath(reportedRoot)) !== root) return;
    return Object.freeze({
      root,
      commonDirectory: await realpath(commonDirectory),
      head: headId,
    });
  } catch {
    return undefined;
  }
}

export async function isClean(
  git: GitCommandAuthority,
  root: string,
): Promise<boolean | undefined> {
  const status = await git.run(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return status === undefined ? undefined : status.stdout.length === 0;
}

export async function branchHead(
  git: GitCommandAuthority,
  root: string,
  branch: string,
): Promise<string | null | undefined> {
  const exists = await git.run(
    root,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    [0, 1],
  );
  if (exists === undefined) return;
  if (exists.exitCode === 1) return null;
  const result = await git.run(root, [
    "rev-parse",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (result === undefined) return;
  const head = singleLine(result.stdout);
  return head !== undefined && objectIdPattern.test(head) ? head : undefined;
}

export async function listWorktrees(
  git: GitCommandAuthority,
  root: string,
): Promise<readonly RegisteredWorktree[] | undefined> {
  const result = await git.run(root, ["worktree", "list", "--porcelain", "-z"]);
  if (result === undefined) return;
  const entries: RegisteredWorktree[] = [];
  let current: { root?: string; head?: string; branch?: string | null } = {};
  for (const field of result.stdout.split("\0")) {
    if (field.length === 0) {
      if (current.root !== undefined && current.head !== undefined) {
        entries.push(
          Object.freeze({
            root: current.root,
            head: current.head,
            branch: current.branch ?? null,
          }),
        );
      }
      current = {};
    } else if (field.startsWith("worktree ")) {
      current.root = field.slice("worktree ".length);
    } else if (field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    }
  }
  return Object.freeze(entries);
}

export async function plainDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }
}

export function isOutside(parent: string, repositoryRoot: string): boolean {
  const fromRepository = relative(repositoryRoot, parent);
  const fromParent = relative(parent, repositoryRoot);
  return (
    fromRepository !== "" &&
    fromParent !== "" &&
    (fromRepository === ".." || fromRepository.startsWith(`..${sep}`)) &&
    (fromParent === ".." || fromParent.startsWith(`..${sep}`))
  );
}

export function exactChild(parent: string, child: string): boolean {
  return (
    resolve(parent, child) === child &&
    relative(parent, child).split(sep).length === 1
  );
}

function singleLine(output: string): string | undefined {
  const value = output.endsWith("\n") ? output.slice(0, -1) : output;
  return value.length > 0 && !value.includes("\n") && !value.includes("\r")
    ? value
    : undefined;
}
