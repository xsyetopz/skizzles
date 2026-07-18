import {
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type FileIdentity,
  identity,
  isOwnedDirectory,
  isOwnedRegularFile,
  sameDirectoryNode,
  sameIdentity,
  validatedRootIdentity,
} from "./run-root.ts";

const maximumStatusBytes = 1024 * 1024;
const generatedRunIdPattern = /^[a-f0-9]{12}$/;
const artifactNames = ["status.json", "stderr.log", "stdout.log"] as const;
const allowedStatusKeys = new Set([
  "id",
  "command",
  "startedAt",
  "completedAt",
  "exitCode",
  "signal",
  "shell",
  "stdoutObservedBytes",
  "stderrObservedBytes",
  "stdoutStoredBytes",
  "stderrStoredBytes",
  "stdoutTruncated",
  "stderrTruncated",
  "artifactCapture",
  "drainIncomplete",
]);

type ArtifactName = (typeof artifactNames)[number];

type RetainedRun = {
  id: string;
  path: string;
  mtime: number;
  size: number;
  directoryIdentity: FileIdentity;
  artifactIdentities: Readonly<Record<ArtifactName, FileIdentity>>;
};

type CompletedStatusMarker = {
  stdoutStoredBytes: number;
  stderrStoredBytes: number;
};

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function validStatusStrings(
  status: Record<string, unknown>,
  id: string,
): boolean {
  return (
    status["id"] === id &&
    typeof status["command"] === "string" &&
    typeof status["shell"] === "string" &&
    typeof status["startedAt"] === "string" &&
    !Number.isNaN(Date.parse(status["startedAt"])) &&
    typeof status["completedAt"] === "string" &&
    !Number.isNaN(Date.parse(status["completedAt"]))
  );
}

function validStatusCounters(status: Record<string, unknown>): boolean {
  return [
    "stdoutObservedBytes",
    "stderrObservedBytes",
    "stdoutStoredBytes",
    "stderrStoredBytes",
  ].every((key) => isNonnegativeInteger(status[key]));
}

function validStatusFlags(status: Record<string, unknown>): boolean {
  return (
    typeof status["stdoutTruncated"] === "boolean" &&
    typeof status["stderrTruncated"] === "boolean" &&
    typeof status["drainIncomplete"] === "boolean" &&
    status["artifactCapture"] === "active"
  );
}

function completedStatus(
  content: string,
  id: string,
): CompletedStatusMarker | undefined {
  let status: unknown;
  try {
    status = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return undefined;
  }
  const record = status as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedStatusKeys.has(key))) {
    return undefined;
  }
  const signal = record["signal"];
  const validSignal =
    signal === undefined ||
    signal === "SIGHUP" ||
    signal === "SIGINT" ||
    signal === "SIGTERM";
  if (
    !(
      validSignal &&
      validStatusStrings(record, id) &&
      validStatusCounters(record) &&
      validStatusFlags(record) &&
      isNonnegativeInteger(record["exitCode"])
    )
  ) {
    return undefined;
  }
  const stdoutStoredBytes = record["stdoutStoredBytes"] as number;
  const stderrStoredBytes = record["stderrStoredBytes"] as number;
  if (
    stdoutStoredBytes > (record["stdoutObservedBytes"] as number) ||
    stderrStoredBytes > (record["stderrObservedBytes"] as number)
  ) {
    return undefined;
  }
  return { stdoutStoredBytes, stderrStoredBytes };
}

function exactArtifactEntries(path: string): boolean {
  try {
    const entries = readdirSync(path).sort();
    return (
      entries.length === artifactNames.length &&
      artifactNames.every((name, index) => entries[index] === name)
    );
  } catch {
    return false;
  }
}

function inspectCompletedRun(
  path: string,
  id: string,
): RetainedRun | undefined {
  try {
    const directory = lstatSync(path);
    if (!(isOwnedDirectory(directory, 0o700) && exactArtifactEntries(path))) {
      return undefined;
    }
    const statusInfo = lstatSync(join(path, "status.json"));
    const stderrInfo = lstatSync(join(path, "stderr.log"));
    const stdoutInfo = lstatSync(join(path, "stdout.log"));
    if (
      !isOwnedRegularFile(statusInfo, 0o600) ||
      statusInfo.size > maximumStatusBytes ||
      !isOwnedRegularFile(stderrInfo, 0o600) ||
      !isOwnedRegularFile(stdoutInfo, 0o600)
    ) {
      return undefined;
    }
    const marker = completedStatus(
      readFileSync(join(path, "status.json"), "utf8"),
      id,
    );
    if (
      !marker ||
      marker.stdoutStoredBytes !== stdoutInfo.size ||
      marker.stderrStoredBytes !== stderrInfo.size
    ) {
      return undefined;
    }
    return {
      id,
      path,
      mtime: directory.mtimeMs,
      size: statusInfo.size + stderrInfo.size + stdoutInfo.size,
      directoryIdentity: identity(directory),
      artifactIdentities: {
        "status.json": identity(statusInfo),
        "stderr.log": identity(stderrInfo),
        "stdout.log": identity(stdoutInfo),
      },
    };
  } catch {
    return undefined;
  }
}

function sameRunIdentity(left: RetainedRun, right: RetainedRun): boolean {
  return (
    left.id === right.id &&
    sameIdentity(left.directoryIdentity, right.directoryIdentity) &&
    artifactNames.every((name) =>
      sameIdentity(
        left.artifactIdentities[name],
        right.artifactIdentities[name],
      ),
    )
  );
}

function restoreQuarantine(quarantine: string, original: string): void {
  try {
    lstatSync(original);
  } catch {
    try {
      renameSync(quarantine, original);
    } catch {
      // A replacement or permission change is preserved rather than deleted.
    }
  }
}

function removeRetainedRun(
  root: string,
  rootIdentity: FileIdentity,
  run: RetainedRun,
): boolean {
  if (dirname(resolve(run.path)) !== root) return false;
  const current = inspectCompletedRun(run.path, run.id);
  if (!(current && sameRunIdentity(run, current))) return false;
  const quarantine = join(root, `.cleanup-${run.id}-${crypto.randomUUID()}`);
  try {
    renameSync(run.path, quarantine);
  } catch {
    return false;
  }
  try {
    const moved = inspectCompletedRun(quarantine, run.id);
    const currentRoot = identity(lstatSync(root));
    const safeToRemove =
      moved !== undefined &&
      sameRunIdentity(run, moved) &&
      sameDirectoryNode(rootIdentity, currentRoot) &&
      dirname(resolve(quarantine)) === root;
    if (!safeToRemove) {
      restoreQuarantine(quarantine, run.path);
      return false;
    }
    rmSync(quarantine, { recursive: true });
    return true;
  } catch {
    restoreQuarantine(quarantine, run.path);
    return false;
  }
}

export function cleanOldRuns(root: string, limit: number): void {
  try {
    const rootIdentity = validatedRootIdentity(root);
    const entries = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && generatedRunIdPattern.test(entry.name),
      )
      .map((entry) => inspectCompletedRun(join(root, entry.name), entry.name))
      .filter((entry): entry is RetainedRun => entry !== undefined)
      .sort((left, right) => left.mtime - right.mtime);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= limit) break;
      if (removeRetainedRun(root, rootIdentity, entry)) total -= entry.size;
    }
  } catch {
    // Retention failure must not prevent the requested command from running.
  }
}
