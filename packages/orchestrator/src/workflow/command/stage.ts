import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  RunWorkspace,
  WorkspaceUsageLimits,
} from "@skizzles/run-workspace";
import type { Digest } from "../../digest.ts";
import type {
  CommandDependencyReceipt,
  CommandScopeTargetReceipt,
} from "../contract.ts";
import type { WorkflowTarget } from "../publication.ts";
import { stageDependencyClosure } from "./dependency/closure.ts";
import { writeOwnedFile } from "./tree/file-io.ts";
import { copyTrustedTree } from "./tree/materialization.ts";
import {
  createMutableStage,
  type StagedDirectory,
  type StagedFile,
  type StagedLink,
  sortByPath,
  validRelativePath,
  withinQuota,
} from "./tree/state.ts";
import { ensureOwnedDirectories } from "./tree/writer.ts";

const excludedDirectories = new Set([
  ".cache",
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

export async function stageRepositoryTree(input: {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly workspace: RunWorkspace;
  readonly limits: WorkspaceUsageLimits;
  readonly targets: readonly WorkflowTarget[];
  readonly dependencyPackages: readonly string[];
}): Promise<
  | {
      readonly files: readonly StagedFile[];
      readonly directories: readonly StagedDirectory[];
      readonly links: readonly StagedLink[];
      readonly targets: readonly CommandScopeTargetReceipt[];
      readonly dependencies: readonly CommandDependencyReceipt[];
      readonly dependencyDigest: Digest;
    }
  | undefined
> {
  const stage = createMutableStage();
  if (
    !(await copyTrustedTree({
      sourceRoot: input.sourceRoot,
      destinationRoot: input.destinationRoot,
      destinationPath: "",
      stage,
      workspace: input.workspace,
      limits: input.limits,
      excludedDirectories,
    }))
  ) {
    return;
  }
  const targets: CommandScopeTargetReceipt[] = [];
  for (const target of input.targets) {
    const receipt = await overlayTarget(
      input.destinationRoot,
      target,
      stage,
      input.workspace,
      input.limits,
    );
    if (receipt === undefined) return;
    targets.push(receipt);
  }
  const dependencies = await stageDependencyClosure({
    sourceRoot: input.sourceRoot,
    destinationRoot: input.destinationRoot,
    dependencyPackages: input.dependencyPackages,
    stage,
    workspace: input.workspace,
    limits: input.limits,
  });
  if (
    dependencies === undefined ||
    !(await withinQuota(input.workspace, input.limits))
  ) {
    return;
  }
  return Object.freeze({
    files: Object.freeze(sortByPath(stage.files.values())),
    directories: Object.freeze(sortByPath(stage.directories.values())),
    links: Object.freeze(sortByPath(stage.links.values())),
    targets: Object.freeze(targets),
    dependencies: dependencies.dependencies,
    dependencyDigest: dependencies.dependencyDigest,
  });
}

async function overlayTarget(
  root: string,
  target: WorkflowTarget,
  stage: ReturnType<typeof createMutableStage>,
  workspace: RunWorkspace,
  limits: WorkspaceUsageLimits,
): Promise<CommandScopeTargetReceipt | undefined> {
  if (!validRelativePath(target.path)) return;
  const parts = target.path.split("/");
  if (excludedDirectories.has(parts[0] ?? "")) return;
  if (
    !(await ensureOwnedDirectories({
      root,
      parts: parts.slice(0, -1),
      stage,
      workspace,
      limits,
    }))
  ) {
    return;
  }
  const path = join(root, ...parts);
  const existing = await optionalLstat(path);
  if (existing !== undefined) {
    const tracked = stage.files.get(target.path);
    if (
      tracked === undefined ||
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1n
    ) {
      return;
    }
    await unlink(path);
    stage.files.delete(target.path);
  }
  if (target.operation === "delete") {
    if (target.candidateBytes !== null) return;
    return Object.freeze({
      path: target.path,
      operation: "delete",
      candidateDigest: null,
    });
  }
  if (target.candidateBytes === null) return;
  const staged = await writeOwnedFile(
    path,
    target.path,
    Uint8Array.from(target.candidateBytes),
    0o600,
  );
  if (staged === undefined) return;
  stage.files.set(target.path, staged);
  if (!(await withinQuota(workspace, limits))) return;
  return Object.freeze({
    path: target.path,
    operation: "write",
    candidateDigest: staged.digest,
  });
}

async function optionalLstat(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
}

function hasCode(error: unknown, expected: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === expected
  );
}
