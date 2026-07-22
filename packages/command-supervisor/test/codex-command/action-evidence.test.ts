import { afterEach, describe, expect, it } from "bun:test";
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
  createRunnerFixture,
  encode,
  exactStatus,
  invoke,
  runner,
  text,
} from "./runner-fixture.ts";

const { cleanupTemporaryDirectories, temporaryDirectory } =
  createRunnerFixture();
afterEach(cleanupTemporaryDirectories);

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
      policy: "per-output-cap-with-pre-run-completed-cleanup",
      maximumOutputArtifactBytes: 16 * 1024 * 1024,
      cleanupThresholdBytes: 256 * 1024 * 1024,
      directoryMode: "0700",
      fileMode: "0600",
    });
    expect(run.status.evidence.stdout).toEqual({
      reference: "stdout.log",
      sensitivity: "operator-private",
      redaction: "none",
      integrity: "unauthenticated-sha256",
      observedBytes: stdout.length,
      storedBytes: stdout.length,
      truncated: false,
      sha256: digest(stdout),
    });
    expect(run.status.evidence.stderr).toEqual({
      reference: "stderr.log",
      sensitivity: "operator-private",
      redaction: "none",
      integrity: "unauthenticated-sha256",
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

  it("accepts a same-user coherent artifact and unauthenticated digest rewrite", () => {
    const run = completedRun("printf original-evidence");
    const replacement = "coherent-replacement";
    writeFileSync(join(run.directory, "stdout.log"), replacement, {
      mode: 0o600,
    });
    const replacementBytes = Buffer.byteLength(replacement);
    const rewritten = {
      ...run.status,
      evidence: {
        ...run.status.evidence,
        stdout: {
          ...run.status.evidence.stdout,
          observedBytes: replacementBytes,
          storedBytes: replacementBytes,
          truncated: false,
          sha256: digest(replacement),
        },
      },
    };
    writeFileSync(run.statusPath, `${JSON.stringify(rewritten)}\n`, {
      mode: 0o600,
    });

    const query = invoke(runner, ["status", run.id], {
      env: { [outputDirectoryEnvironment]: run.root },
    });
    expect(query.exitCode).toBe(0);
    expect(text(query.stdout)).toBe(`${JSON.stringify(rewritten)}\n`);
    expect(rewritten.evidence.stdout.integrity).toBe("unauthenticated-sha256");
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
      {
        ...run.status,
        lifecycle: {
          ...run.status.lifecycle,
          completedAt: "1970-01-01T00:00:00.000Z",
        },
      },
      {
        ...run.status,
        lifecycle: {
          ...run.status.lifecycle,
          cancellationSignal: "SIGTERM",
          cleanup: "not-required",
        },
      },
      {
        ...run.status,
        lifecycle: { ...run.status.lifecycle, state: "running" },
      },
      {
        ...run.status,
        lifecycle: {
          ...run.status.lifecycle,
          state: "failed-to-start",
          exitCode: 126,
          cancellationSignal: null,
          drain: "complete",
          cleanup: "not-required",
        },
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

  it("keeps the pre-run cleanup threshold at least as large as an enlarged output cap", () => {
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
    expect(status.retention.maximumOutputArtifactBytes).toBe(maximumBytes);
    expect(status.retention.cleanupThresholdBytes).toBe(maximumBytes);
  });
});
