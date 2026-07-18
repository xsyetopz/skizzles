import {
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { verifyRunEvidence } from "./run-evidence.ts";
import {
  type FileIdentity,
  identity,
  isOwnedDirectory,
  isOwnedRegularFile,
  sameDirectoryNode,
  sameIdentity,
  validatedRootIdentity,
} from "./run-root.ts";
import { maximumStatusBytes, parseRunStatus } from "./run-status-codec.ts";

const generatedRunIdPattern = /^[a-f0-9]{12}$/;
const artifactNames = ["status.json", "stderr.log", "stdout.log"] as const;

type ArtifactName = (typeof artifactNames)[number];

type RetainedRun = {
  id: string;
  path: string;
  mtime: number;
  size: number;
  directoryIdentity: FileIdentity;
  artifactIdentities: Readonly<Record<ArtifactName, FileIdentity>>;
};

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
    const status = parseRunStatus(
      readFileSync(join(path, "status.json"), "utf8"),
      id,
    );
    if (
      status.lifecycle.state === "running" ||
      stdoutInfo.size !== status.evidence.stdout.storedBytes ||
      stderrInfo.size !== status.evidence.stderr.storedBytes ||
      stdoutInfo.size > status.retention.maximumOutputArtifactBytes ||
      stderrInfo.size > status.retention.maximumOutputArtifactBytes ||
      !verifyRunEvidence(
        status,
        readFileSync(join(path, "stdout.log")),
        readFileSync(join(path, "stderr.log")),
      )
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
  if (dirname(resolve(run.path)) !== root) {
    return false;
  }
  const current = inspectCompletedRun(run.path, run.id);
  if (!(current && sameRunIdentity(run, current))) {
    return false;
  }
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
      if (total <= limit) {
        break;
      }
      if (removeRetainedRun(root, rootIdentity, entry)) {
        total -= entry.size;
      }
    }
  } catch {
    // Retention failure must not prevent the requested command from running.
  }
}
