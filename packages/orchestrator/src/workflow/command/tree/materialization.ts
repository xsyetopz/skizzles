import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  RunWorkspace,
  WorkspaceUsageLimits,
} from "@skizzles/run-workspace";
import { identity, sameIdentity } from "../identity.ts";
import {
  readTrustedFile,
  trustedDirectory,
  trustedRegularFile,
  writeOwnedFile,
} from "./file-io.ts";
import { type MutableStage, pathInRoot, withinQuota } from "./state.ts";
import { ensureOwnedDirectories } from "./writer.ts";

interface CopyInput {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly destinationPath: string;
  readonly stage: MutableStage;
  readonly workspace: RunWorkspace;
  readonly limits: WorkspaceUsageLimits;
  readonly excludedDirectories: ReadonlySet<string>;
}

interface DirectoryCopyInput extends CopyInput {
  readonly sourceDirectory: string;
}

export async function copyTrustedTree(input: CopyInput): Promise<boolean> {
  if (
    input.destinationPath !== "" &&
    !(await ensureOwnedDirectories({
      root: input.destinationRoot,
      parts: input.destinationPath.split("/"),
      stage: input.stage,
      workspace: input.workspace,
      limits: input.limits,
    }))
  ) {
    return false;
  }
  return copyDirectory({ ...input, sourceDirectory: "" });
}

async function copyDirectory(input: DirectoryCopyInput): Promise<boolean> {
  const source = pathInRoot(input.sourceRoot, input.sourceDirectory);
  const sourceBefore = await lstat(source, { bigint: true });
  if (!trustedDirectory(sourceBefore)) return false;
  const names = (await readdir(source)).sort((left, right) =>
    left.localeCompare(right),
  );
  for (const name of names) {
    const sourceRelative = joinRelative(input.sourceDirectory, name);
    const destinationRelative = joinRelative(
      input.destinationPath,
      sourceRelative,
    );
    const sourcePath = join(source, name);
    const sourceStat = await lstat(sourcePath, { bigint: true });
    if (sourceStat.isSymbolicLink()) return false;
    if (sourceStat.isDirectory()) {
      if (
        !input.excludedDirectories.has(name) &&
        !(
          (await ensureOwnedDirectories({
            root: input.destinationRoot,
            parts: destinationRelative.split("/"),
            stage: input.stage,
            workspace: input.workspace,
            limits: input.limits,
          })) &&
          (await copyDirectory({
            ...input,
            sourceDirectory: sourceRelative,
          }))
        )
      ) {
        return false;
      }
    } else if (
      !(await copyFile(input, sourcePath, sourceStat, destinationRelative))
    ) {
      return false;
    }
  }
  const sourceAfter = await lstat(source, { bigint: true });
  return (
    trustedDirectory(sourceAfter) &&
    sameIdentity(sourceAfter, identity(sourceBefore)) &&
    (await realpath(source)) === source
  );
}

async function copyFile(
  input: CopyInput,
  sourcePath: string,
  sourceStat: BigIntStats,
  destinationRelative: string,
): Promise<boolean> {
  if (!trustedRegularFile(sourceStat)) return false;
  const bytes = await readTrustedFile(sourcePath, sourceStat);
  if (bytes === undefined) return false;
  const staged = await writeOwnedFile(
    join(input.destinationRoot, destinationRelative),
    destinationRelative,
    bytes,
    executableMode(sourceStat),
  );
  if (staged === undefined) return false;
  input.stage.files.set(destinationRelative, staged);
  return withinQuota(input.workspace, input.limits);
}

function joinRelative(parent: string, child: string): string {
  if (parent === "") return child;
  return `${parent}/${child}`;
}

function executableMode(stat: BigIntStats): 0o600 | 0o700 {
  if ((stat.mode & 0o111n) === 0n) return 0o600;
  return 0o700;
}
