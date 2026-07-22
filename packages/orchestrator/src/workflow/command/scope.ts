import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import type {
  RunWorkspace,
  WorkspaceUsageLimits,
} from "@skizzles/run-workspace";
import { digestValue } from "../../digest.ts";
import type { CommandScopeReceipt } from "../contract.ts";
import type { WorkflowTarget } from "../publication.ts";
import {
  identity,
  type OwnedIdentity,
  privateDirectory,
  sameIdentity,
} from "./identity.ts";
import { stageRepositoryTree } from "./stage.ts";
import type { StagedDirectory, StagedFile, StagedLink } from "./tree/state.ts";
import { verifyStagedTree } from "./tree/verification.ts";

export interface CommandScope {
  readonly cwd: string;
  readonly root: string;
  readonly cwdReal: string;
  readonly rootReal: string;
  readonly repositoryRoot: string;
  readonly repositoryReal: string;
  readonly rootIdentity: OwnedIdentity;
  readonly cwdIdentity: OwnedIdentity;
  readonly repositoryIdentity: OwnedIdentity;
  readonly files: readonly StagedFile[];
  readonly directories: readonly StagedDirectory[];
  readonly links: readonly StagedLink[];
  readonly receipt: CommandScopeReceipt;
}

export async function createCommandScope(input: {
  readonly workspace: RunWorkspace;
  readonly sequence: number;
  readonly repositoryRoot: string;
  readonly limits: WorkspaceUsageLimits;
  readonly targets: readonly WorkflowTarget[];
  readonly dependencyPackages: readonly string[];
}): Promise<CommandScope | undefined> {
  try {
    const root = dirname(input.workspace.path("owned-root-anchor"));
    const rootStat = await lstat(root, { bigint: true });
    if (!privateDirectory(rootStat)) return;
    const rootIdentity = identity(rootStat);
    const rootReal = await realpath(root);
    const repositoryRoot = await resolveRepositoryRoot(input.repositoryRoot);
    if (repositoryRoot === undefined) return;
    const repositoryStat = await lstat(repositoryRoot, { bigint: true });
    if (!trustedDirectory(repositoryStat)) return;
    const repositoryIdentity = identity(repositoryStat);
    const repositoryReal = await realpath(repositoryRoot);
    if (repositoryReal !== repositoryRoot) return;
    const allocated = await allocateCommandDirectory(
      input.workspace,
      input.sequence,
    );
    if (allocated === undefined) return;
    const { cwd, name } = allocated;
    const cwdStat = await lstat(cwd, { bigint: true });
    const cwdReal = await realpath(cwd);
    if (
      !privateDirectory(cwdStat) ||
      cwdStat.dev !== rootStat.dev ||
      dirname(cwd) !== root ||
      cwdReal !== join(rootReal, name) ||
      dirname(cwdReal) !== rootReal
    ) {
      return;
    }
    const staged = await stageRepositoryTree({
      sourceRoot: repositoryRoot,
      destinationRoot: cwd,
      workspace: input.workspace,
      limits: input.limits,
      targets: input.targets,
      dependencyPackages: input.dependencyPackages,
    });
    if (staged === undefined) return;
    if (
      !(
        (await matchesDirectory(root, rootIdentity, rootReal, true)) &&
        (await matchesDirectory(
          repositoryRoot,
          repositoryIdentity,
          repositoryReal,
          false,
        ))
      )
    ) {
      return;
    }
    const targetReceipts = Object.freeze(
      staged.targets.map((target) => Object.freeze({ ...target })),
    );
    const receipt: CommandScopeReceipt = Object.freeze({
      stagedTreeDigest: digestValue({
        directories: staged.directories.map(({ path }) => path),
        files: staged.files.map(({ path, digest }) => ({ path, digest })),
        links: staged.links.map(({ path, target }) => ({ path, target })),
      }),
      candidateDigest: digestValue(targetReceipts),
      dependencyDigest: staged.dependencyDigest,
      dependencies: staged.dependencies,
      targets: targetReceipts,
    });
    return Object.freeze({
      cwd,
      root,
      cwdReal,
      rootReal,
      repositoryRoot,
      repositoryReal,
      rootIdentity,
      cwdIdentity: identity(cwdStat),
      repositoryIdentity,
      files: staged.files,
      directories: staged.directories,
      links: staged.links,
      receipt,
    });
  } catch {
    return undefined;
  }
}

export async function verifyCommandScope(
  scope: CommandScope,
): Promise<boolean> {
  try {
    return (
      (await matchesDirectory(
        scope.root,
        scope.rootIdentity,
        scope.rootReal,
        true,
      )) &&
      (await matchesDirectory(
        scope.cwd,
        scope.cwdIdentity,
        scope.cwdReal,
        true,
      )) &&
      (await matchesDirectory(
        scope.repositoryRoot,
        scope.repositoryIdentity,
        scope.repositoryReal,
        false,
      )) &&
      dirname(scope.cwd) === scope.root &&
      dirname(scope.cwdReal) === scope.rootReal &&
      (await verifyStagedTree(
        scope.cwd,
        scope.files,
        scope.directories,
        scope.links,
      ))
    );
  } catch {
    return false;
  }
}

function trustedDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

async function resolveRepositoryRoot(
  declaredRoot: string,
): Promise<string | undefined> {
  if (isAbsolute(declaredRoot) || declaredRoot === ".") {
    return validRepositoryRoot(resolve(declaredRoot));
  }
  const matches: string[] = [];
  let ancestor = process.cwd();
  while (true) {
    const candidate = resolve(ancestor, declaredRoot);
    if ((await validRepositoryRoot(candidate)) !== undefined) {
      matches.push(candidate);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function validRepositoryRoot(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path, { bigint: true });
    if (!trustedDirectory(stat) || (await realpath(path)) !== path) {
      return;
    }
    return path;
  } catch {
    return undefined;
  }
}

async function matchesDirectory(
  path: string,
  expected: OwnedIdentity,
  expectedReal: string,
  privateMode: boolean,
): Promise<boolean> {
  const stat = await lstat(path, { bigint: true });
  const valid = privateMode ? privateDirectory(stat) : trustedDirectory(stat);
  return (
    valid &&
    sameIdentity(stat, expected) &&
    (await realpath(path)) === expectedReal
  );
}

async function allocateCommandDirectory(
  workspace: RunWorkspace,
  sequence: number,
): Promise<{ readonly cwd: string; readonly name: string } | undefined> {
  const maximumAttempts = 8;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const name = `command-${sequence}-${randomUUID()}`;
    const cwd = workspace.path(name);
    try {
      await mkdir(cwd, { mode: 0o700, recursive: false });
      return Object.freeze({ cwd, name });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  return undefined;
}

function hasCode(error: unknown, expected: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === expected
  );
}
