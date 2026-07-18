import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamName } from "../contract.ts";
import { retainedOutputTailBytes } from "./artifacts.ts";
import { verifyRunEvidence } from "./evidence.ts";
import {
  isOwnedDirectory,
  isOwnedRegularFile,
  validateExistingRoot,
} from "./root.ts";
import { maximumStatusBytes, parseRunStatus } from "./status-codec.ts";

const queryRunIdPattern = /^[A-Za-z0-9._-]+$/;

function validateQueryRunId(id: string): void {
  if (id === "." || id === ".." || !queryRunIdPattern.test(id)) {
    throw new Error("invalid run id");
  }
}

function requireRegularArtifact(
  directory: string,
  filename: string,
  label: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): string {
  const path = join(directory, filename);
  try {
    const info = lstatSync(path);
    if (!isOwnedRegularFile(info, 0o600) || info.size > maximumBytes) {
      throw new Error("not an owned file");
    }
    return path;
  } catch {
    throw new Error(`${label} artifact unavailable`);
  }
}

export class RunStoreQueries {
  private readonly requestedRoot: string;

  constructor(root: string) {
    this.requestedRoot = root;
  }

  private root(): string {
    try {
      return validateExistingRoot(this.requestedRoot);
    } catch {
      throw new Error("run store unavailable");
    }
  }

  private requireRunDirectory(id: string): string {
    validateQueryRunId(id);
    const directory = join(this.root(), id);
    try {
      const info = lstatSync(directory);
      if (isOwnedDirectory(info, 0o700)) {
        return directory;
      }
    } catch {
      // The controlled not-found diagnostic below covers lookup failures.
    }
    throw new Error(`run not found: ${id}`);
  }

  status(id: string): string {
    const directory = this.requireRunDirectory(id);
    const path = requireRegularArtifact(
      directory,
      "status.json",
      "status",
      maximumStatusBytes,
    );
    try {
      const content = readFileSync(path, "utf8");
      const status = parseRunStatus(content, id);
      const stdoutPath = requireRegularArtifact(
        directory,
        status.evidence.stdout.reference,
        "stdout log",
        status.retention.maximumOutputArtifactBytes,
      );
      const stderrPath = requireRegularArtifact(
        directory,
        status.evidence.stderr.reference,
        "stderr log",
        status.retention.maximumOutputArtifactBytes,
      );
      if (
        !verifyRunEvidence(
          status,
          readFileSync(stdoutPath),
          readFileSync(stderrPath),
        )
      ) {
        throw new Error("status evidence mismatch");
      }
      return content;
    } catch {
      throw new Error("status artifact unavailable");
    }
  }

  tail(id: string, stream: StreamName): string {
    const directory = this.requireRunDirectory(id);
    const filename = stream === "stdout" ? "stdout.log" : "stderr.log";
    const path = requireRegularArtifact(directory, filename, `${stream} log`);
    try {
      const content = readFileSync(path);
      return content
        .subarray(Math.max(0, content.length - retainedOutputTailBytes))
        .toString("utf8");
    } catch {
      throw new Error(`${stream} log artifact unavailable`);
    }
  }

  search(needle: string, id: string | undefined): string[] {
    if (!needle || needle.length > 256) {
      throw new Error("search text must be 1-256 characters");
    }
    const directories = id
      ? [this.requireRunDirectory(id)]
      : this.retainedRunDirectories();
    const matches: string[] = [];
    for (const directory of directories) {
      for (const filename of ["stdout.log", "stderr.log"]) {
        try {
          const path = requireRegularArtifact(directory, filename, filename);
          if (readFileSync(path, "utf8").includes(needle)) {
            matches.push(path);
          }
        } catch {
          // Search skips missing artifacts from partial retained runs.
        }
      }
    }
    return matches;
  }

  private retainedRunDirectories(): string[] {
    const root = this.root();
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => {
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            return false;
          }
          try {
            return isOwnedDirectory(lstatSync(join(root, entry.name)), 0o700);
          } catch {
            return false;
          }
        })
        .map((entry) => join(root, entry.name));
    } catch {
      throw new Error("run store unavailable");
    }
  }
}
