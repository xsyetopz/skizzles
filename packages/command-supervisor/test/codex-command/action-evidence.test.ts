// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  artifactPath,
  encode,
  exactStatus,
  invoke,
  runner,
  temporaryDirectory,
  text,
} from "./runner-fixture.ts";

const actionLabelPattern = /^[a-z][a-z -]{0,63}$/u;
const maximumBytesEnvironment = "CODEX_COMMAND_MAX_BYTES";
const outputDirectoryEnvironment = "CODEX_COMMAND_OUTPUT_DIR";
const shellEnvironment = "SHELL";

function digest(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function completedRun(script: string, root = temporaryDirectory()) {
  const result = invoke(runner, ["run", "--base64url", encode(script)], {
    env: { [outputDirectoryEnvironment]: root },
  });
  if (result.exitCode !== 0) {
    throw new Error(`command failed: ${text(result.stderr)}`);
  }
  const directory = artifactPath(text(result.stdout));
  const id = directory.split("/").at(-1);
  if (!id) {
    throw new Error(`run id missing from ${directory}`);
  }
  const statusPath = join(directory, "status.json");
  const content = readFileSync(statusPath, "utf8");
  return {
    root,
    directory,
    id,
    statusPath,
    content,
    status: exactStatus(content, id),
  };
}

describe("versioned privacy-preserving action evidence", () => {
  it("binds the exact action without retaining its secret-bearing text", () => {
    const secret = "action-secret-do-not-retain-7bdb9f";
    const script = `secret_marker='${secret}'; test -n "$secret_marker"; printf public-output`;
    const run = completedRun(script);
    const query = invoke(runner, ["status", run.id], {
      env: { [outputDirectoryEnvironment]: run.root },
    });

    expect(query.exitCode).toBe(0);
    expect(text(query.stdout)).toBe(run.content);
    expect(run.status.schema).toBe("skizzles.command-supervisor/run-status");
    expect(run.status.version).toBe(1);
    expect(run.status.action.sha256).toBe(digest(script));
    expect(run.status.action.sha256).not.toBe(digest(`${script} `));
    expect(run.status.action.label).toMatch(actionLabelPattern);
    expect(run.status.action.sensitivity).toBe("secret-bearing");
    expect(run.status.action.redaction).toBe("content-omitted");
    expect(run.content).not.toContain(secret);
    expect(text(query.stdout)).not.toContain(secret);

    for (const artifact of readdirSync(run.directory)) {
      expect(readFileSync(join(run.directory, artifact), "utf8")).not.toContain(
        secret,
      );
    }
  });

  it("classifies bounded output as unredacted operator-private evidence", () => {
    const run = completedRun("printf exact-output; printf exact-error >&2");
    const stdout = readFileSync(join(run.directory, "stdout.log"));
    const stderr = readFileSync(join(run.directory, "stderr.log"));

    expect(run.status.retention).toEqual({
      policy: "size-bound",
      maximumArtifactBytes: 16 * 1024 * 1024,
      maximumStoreBytes: 256 * 1024 * 1024,
      directoryMode: "0700",
      fileMode: "0600",
    });
    expect(run.status.evidence.stdout).toEqual({
      reference: "stdout.log",
      sensitivity: "operator-private",
      redaction: "none",
      observedBytes: stdout.length,
      storedBytes: stdout.length,
      truncated: false,
      sha256: digest(stdout),
    });
    expect(run.status.evidence.stderr).toEqual({
      reference: "stderr.log",
      sensitivity: "operator-private",
      redaction: "none",
      observedBytes: stderr.length,
      storedBytes: stderr.length,
      truncated: false,
      sha256: digest(stderr),
    });
    expect(statSync(run.directory).mode & 0o777).toBe(0o700);
    for (const artifact of readdirSync(run.directory)) {
      expect(statSync(join(run.directory, artifact)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects altered retained evidence instead of returning unbound status", () => {
    const run = completedRun("printf original-evidence");
    writeFileSync(join(run.directory, "stdout.log"), "altered-evidence!", {
      mode: 0o600,
    });

    const query = invoke(runner, ["status", run.id], {
      env: { [outputDirectoryEnvironment]: run.root },
    });
    expect(query.exitCode).toBe(64);
    expect(text(query.stdout)).toBe("");
    expect(text(query.stderr)).toContain("status artifact unavailable");
  });

  it("rejects unknown, malformed, and unsupported-version status fields", () => {
    const run = completedRun("printf schema-bound");
    const invalidStatuses = [
      { ...run.status, unexpected: true },
      { ...run.status, version: 2 },
      {
        ...run.status,
        lifecycle: { ...run.status.lifecycle, cleanup: "pending" },
      },
    ];

    for (const invalid of invalidStatuses) {
      writeFileSync(run.statusPath, `${JSON.stringify(invalid)}\n`, {
        mode: 0o600,
      });
      const query = invoke(runner, ["status", run.id], {
        env: { [outputDirectoryEnvironment]: run.root },
      });
      expect(query.exitCode).toBe(64);
      expect(text(query.stdout)).toBe("");
      expect(text(query.stderr)).toContain("status artifact unavailable");
    }
  });

  it("records a deterministic failed-start terminal outcome", () => {
    const root = temporaryDirectory();
    const invalidShell = join(temporaryDirectory(), "sh");
    mkdirSync(invalidShell, { mode: 0o700 });
    const result = invoke(
      runner,
      ["run", "--base64url", encode("printf never-started")],
      {
        env: {
          [outputDirectoryEnvironment]: root,
          [shellEnvironment]: invalidShell,
        },
      },
    );
    expect(result.exitCode).toBe(127);
    const directory = artifactPath(text(result.stdout));
    const id = directory.split("/").at(-1);
    if (!id) {
      throw new Error(`run id missing from ${directory}`);
    }
    const status = exactStatus(
      readFileSync(join(directory, "status.json"), "utf8"),
      id,
    );
    expect(status.lifecycle.state).toBe("failed-to-start");
    expect(status.lifecycle.exitCode).toBe(127);
    expect(status.lifecycle.cancellationSignal).toBeNull();
    expect(status.lifecycle.drain).toBe("complete");
    expect(status.lifecycle.cleanup).toBe("not-required");
    expect(status.lifecycle.completedAt).toBeString();
    expect(text(result.stderr)).toContain("unable to start command");
    const query = invoke(runner, ["status", id], {
      env: { [outputDirectoryEnvironment]: root },
    });
    expect(query.exitCode).toBe(0);
    expect(exactStatus(text(query.stdout), id).lifecycle.state).toBe(
      "failed-to-start",
    );
  });

  it("keeps the store bound at least as large as an enlarged artifact bound", () => {
    const root = temporaryDirectory();
    const maximumBytes = 300 * 1024 * 1024;
    const result = invoke(
      runner,
      ["run", "--base64url", encode("printf bounded")],
      {
        env: {
          [outputDirectoryEnvironment]: root,
          [maximumBytesEnvironment]: String(maximumBytes),
        },
      },
    );
    expect(result.exitCode).toBe(0);
    const directory = artifactPath(text(result.stdout));
    const id = directory.split("/").at(-1);
    if (!id) {
      throw new Error(`run id missing from ${directory}`);
    }
    const status = exactStatus(
      readFileSync(join(directory, "status.json"), "utf8"),
      id,
    );
    expect(status.retention.maximumArtifactBytes).toBe(maximumBytes);
    expect(status.retention.maximumStoreBytes).toBe(maximumBytes);
  });
});
