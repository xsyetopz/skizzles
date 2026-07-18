import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { cleanOldRuns } from "./run-retention.ts";
import {
  type FileIdentity,
  identity,
  isOwnedDirectory,
  isOwnedRegularFile,
  prepareRunRoot,
  sameDirectoryNode,
  sameIdentity,
  validatedRootIdentity,
} from "./run-root.ts";
import type { RunStatus } from "./run-status.ts";
import { serializeRunStatus } from "./run-status-codec.ts";

export const retainedOutputTailBytes = 1_200;

export type RunArtifacts = {
  directory: string | undefined;
  statusPath: string | undefined;
  stdoutFile: number | undefined;
  stderrFile: number | undefined;
  available: boolean;
  setupError: string | undefined;
};

function closeArtifact(file: number | undefined): void {
  if (file === undefined) {
    return;
  }
  try {
    closeSync(file);
  } catch {
    // Closing is best effort during process teardown.
  }
}

export function createRunId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

export function prepareRunArtifacts(
  root: string,
  id: string,
  maximumDiskBytes: number,
): RunArtifacts {
  let directory: string | undefined;
  let statusPath: string | undefined;
  let stdoutFile: number | undefined;
  let stderrFile: number | undefined;
  try {
    const physicalRoot = prepareRunRoot(root);
    cleanOldRuns(physicalRoot, maximumDiskBytes);
    validatedRootIdentity(physicalRoot);
    directory = join(physicalRoot, id);
    mkdirSync(directory, { mode: 0o700 });
    if (!isOwnedDirectory(lstatSync(directory), 0o700)) {
      throw new Error("run directory is not owner-only");
    }
    stdoutFile = openSync(join(directory, "stdout.log"), "wx", 0o600);
    stderrFile = openSync(join(directory, "stderr.log"), "wx", 0o600);
    statusPath = join(directory, "status.json");
    return {
      directory,
      statusPath,
      stdoutFile,
      stderrFile,
      available: true,
      setupError: undefined,
    };
  } catch (error) {
    closeArtifact(stdoutFile);
    closeArtifact(stderrFile);
    return {
      directory,
      statusPath: undefined,
      stdoutFile: undefined,
      stderrFile: undefined,
      available: false,
      setupError: error instanceof Error ? error.message : "unknown error",
    };
  }
}

export function closeRunArtifacts(artifacts: RunArtifacts): void {
  closeArtifact(artifacts.stdoutFile);
  closeArtifact(artifacts.stderrFile);
}

function writeAll(file: number, content: Uint8Array): void {
  let offset = 0;
  while (offset < content.length) {
    const written = writeSync(file, content, offset, content.length - offset);
    if (written <= 0) {
      throw new Error("unable to persist status artifact");
    }
    offset += written;
  }
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function statusIdentity(path: string): FileIdentity | undefined {
  try {
    const info = lstatSync(path);
    if (!isOwnedRegularFile(info, 0o600)) {
      throw new Error("status artifact is not owner-only");
    }
    return identity(info);
  } catch (error) {
    if (missingPath(error)) {
      return undefined;
    }
    throw error;
  }
}

function sameOptionalIdentity(
  left: FileIdentity | undefined,
  right: FileIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return sameIdentity(left, right);
}

function cleanupOwnedTemporary(
  path: string,
  expected: FileIdentity | undefined,
): void {
  if (!expected) {
    return;
  }
  try {
    const current = identity(lstatSync(path));
    if (sameDirectoryNode(expected, current)) {
      unlinkSync(path);
    }
  } catch {
    // Missing or replaced temporary paths are never recursively removed.
  }
}

function fsyncRunDirectory(directory: string, expected: FileIdentity): void {
  let file: number | undefined;
  try {
    file = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(file);
    const unchangedDirectory =
      isOwnedDirectory(info, 0o700) &&
      sameDirectoryNode(expected, identity(info));
    if (!unchangedDirectory) {
      throw new Error("run directory identity changed");
    }
    fsyncSync(file);
  } finally {
    closeArtifact(file);
  }
}

function statusWriteBoundary(statusPath: string, status: RunStatus) {
  const directory = dirname(statusPath);
  const root = dirname(directory);
  if (
    basename(statusPath) !== "status.json" ||
    basename(directory) !== status.id ||
    realpathSync(directory) !== directory
  ) {
    throw new Error("status path escaped its run directory");
  }
  const rootIdentity = validatedRootIdentity(root);
  const directoryInfo = lstatSync(directory);
  if (!isOwnedDirectory(directoryInfo, 0o700)) {
    throw new Error("run directory is not owner-only");
  }
  return {
    root,
    rootIdentity,
    directory,
    directoryIdentity: identity(directoryInfo),
    previousStatusIdentity: statusIdentity(statusPath),
  };
}

export function writeStatus(
  statusPath: string | undefined,
  status: RunStatus,
): void {
  if (!statusPath) {
    return;
  }
  let file: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let temporaryPath: string | undefined;
  try {
    const boundary = statusWriteBoundary(statusPath, status);
    const content = Buffer.from(serializeRunStatus(status));
    temporaryPath = join(
      boundary.directory,
      `.status-${crypto.randomUUID()}.tmp`,
    );
    file = openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const temporaryInfo = fstatSync(file);
    temporaryIdentity = identity(temporaryInfo);
    if (!isOwnedRegularFile(temporaryInfo, 0o600)) {
      throw new Error("status temporary is not owner-only");
    }
    writeAll(file, content);
    fsyncSync(file);
    temporaryIdentity = identity(fstatSync(file));
    closeArtifact(file);
    file = undefined;

    const currentRootIdentity = validatedRootIdentity(boundary.root);
    const currentDirectoryInfo = lstatSync(boundary.directory);
    const currentDirectoryIdentity = identity(currentDirectoryInfo);
    const currentStatusIdentity = statusIdentity(statusPath);
    const currentTemporaryIdentity = identity(lstatSync(temporaryPath));
    const unchangedBoundary =
      sameDirectoryNode(boundary.rootIdentity, currentRootIdentity) &&
      isOwnedDirectory(currentDirectoryInfo, 0o700) &&
      sameDirectoryNode(boundary.directoryIdentity, currentDirectoryIdentity) &&
      sameIdentity(temporaryIdentity, currentTemporaryIdentity) &&
      sameOptionalIdentity(
        boundary.previousStatusIdentity,
        currentStatusIdentity,
      );
    if (!unchangedBoundary) {
      throw new Error("status write boundary changed");
    }
    renameSync(temporaryPath, statusPath);
    temporaryPath = undefined;
    fsyncRunDirectory(boundary.directory, boundary.directoryIdentity);
  } catch {
    // Status persistence is best effort; command supervision must continue.
  } finally {
    closeArtifact(file);
    if (temporaryPath) {
      cleanupOwnedTemporary(temporaryPath, temporaryIdentity);
    }
  }
}

export function artifactContents(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function artifactTail(path: string): string {
  try {
    const content = readFileSync(path);
    return content
      .subarray(Math.max(0, content.length - retainedOutputTailBytes))
      .toString("utf8");
  } catch {
    return "";
  }
}
