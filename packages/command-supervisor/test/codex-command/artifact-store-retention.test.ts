// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  artifactPath,
  encode,
  exitWithin,
  invoke,
  runner,
  spawnRunner,
  stopProcess,
  temporaryDirectory,
  text,
  waitForFile,
  waitForRunDirectory,
  writeCompletedRun,
} from "./runner-fixture.ts";

describe("artifact-store safety and retention", () => {
  it("caps each output and treats the disk setting as a pre-run completed cleanup threshold", () => {
    const root = temporaryDirectory();
    const environment = {
      CODEX_COMMAND_OUTPUT_DIR: root,
      CODEX_COMMAND_MAX_BYTES: "12",
      CODEX_COMMAND_MAX_DISK_BYTES: "12",
    };
    const first = invoke(
      runner,
      [
        "run",
        "--base64url",
        encode("printf 123456789012; printf abcdefghijkl >&2"),
      ],
      { env: environment },
    );
    expect(first.exitCode).toBe(0);
    const firstDirectory = artifactPath(text(first.stdout));
    const firstStatus = JSON.parse(
      readFileSync(join(firstDirectory, "status.json"), "utf8"),
    );
    expect(firstStatus.retention).toEqual({
      policy: "per-output-cap-with-pre-run-completed-cleanup",
      maximumOutputArtifactBytes: 12,
      cleanupThresholdBytes: 12,
      directoryMode: "0700",
      fileMode: "0600",
    });
    expect(statSync(join(firstDirectory, "stdout.log")).size).toBe(12);
    expect(statSync(join(firstDirectory, "stderr.log")).size).toBe(12);
    const retainedBytes = readdirSync(firstDirectory).reduce(
      (total, name) => total + statSync(join(firstDirectory, name)).size,
      0,
    );
    expect(retainedBytes).toBeGreaterThan(12);

    const second = invoke(
      runner,
      ["run", "--base64url", encode("printf next")],
      { env: environment },
    );
    expect(second.exitCode).toBe(0);
    expect(existsSync(firstDirectory)).toBe(false);
  });

  it("rejects a symlink output root without mutating its target", () => {
    const container = temporaryDirectory();
    const outside = temporaryDirectory();
    const linkedRoot = join(container, "linked-output");
    symlinkSync(outside, linkedRoot);
    const beforeMode = statSync(outside).mode & 0o777;

    const result = invoke(
      runner,
      ["run", "--base64url", encode("printf still-runs")],
      { env: { CODEX_COMMAND_OUTPUT_DIR: linkedRoot } },
    );

    expect(result.exitCode).toBe(0);
    expect(text(result.stderr)).toContain("artifact capture unavailable");
    expect(text(result.stdout)).toContain("still-runs");
    expect(statSync(outside).mode & 0o777).toBe(beforeMode);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects a non-owner-only output root without changing its mode", () => {
    const root = temporaryDirectory();
    chmodSync(root, 0o755);
    const result = invoke(
      runner,
      ["run", "--base64url", encode("printf mode-safe")],
      { env: { CODEX_COMMAND_OUTPUT_DIR: root } },
    );

    expect(result.exitCode).toBe(0);
    expect(text(result.stderr)).toContain("artifact capture unavailable");
    expect(text(result.stdout)).toContain("mode-safe");
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(readdirSync(root)).toEqual([]);
  });

  it("retention removes only validated completed runs and preserves foreign directories", () => {
    const root = temporaryDirectory();
    const completed = writeCompletedRun(root, "000000000001", "oversized");
    const foreign = join(root, "unrelated-data");
    mkdirSync(foreign, { mode: 0o700 });
    writeFileSync(join(foreign, "sentinel"), "must remain", { mode: 0o600 });
    const malformedRun = join(root, "000000000002");
    mkdirSync(malformedRun, { mode: 0o700 });
    writeFileSync(join(malformedRun, "sentinel"), "also remain", {
      mode: 0o600,
    });
    const mismatchedRun = writeCompletedRun(root, "000000000003", "short");
    writeFileSync(join(mismatchedRun, "stdout.log"), "replacement transcript");

    const result = invoke(
      runner,
      ["run", "--base64url", encode("printf replacement")],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: root,
          CODEX_COMMAND_MAX_BYTES: "1",
          CODEX_COMMAND_MAX_DISK_BYTES: "1",
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(completed)).toBe(false);
    expect(readFileSync(join(foreign, "sentinel"), "utf8")).toBe("must remain");
    expect(readFileSync(join(malformedRun, "sentinel"), "utf8")).toBe(
      "also remain",
    );
    expect(readFileSync(join(mismatchedRun, "stdout.log"), "utf8")).toBe(
      "replacement transcript",
    );
  });

  it("retention cannot delete an active concurrent run", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = temporaryDirectory();
    const ready = join(root, "active.ready");
    const active = spawnRunner(
      `trap '' TERM; printf active-transcript; printf ready > '${ready}'; while :; do sleep 1; done`,
      root,
      { CODEX_COMMAND_SIGNAL_GRACE_MS: "100" },
    );
    await waitForFile(ready);
    const activeDirectory = await waitForRunDirectory(root);
    const initialStatus = JSON.parse(
      readFileSync(join(activeDirectory, "status.json"), "utf8"),
    );
    expect(initialStatus.lifecycle.completedAt).toBeNull();
    expect(initialStatus.lifecycle.state).toBe("running");

    const cleanup = invoke(
      runner,
      ["run", "--base64url", encode("printf cleanup-run")],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: root,
          CODEX_COMMAND_MAX_BYTES: "1",
          CODEX_COMMAND_MAX_DISK_BYTES: "1",
        },
      },
    );
    expect(cleanup.exitCode).toBe(0);
    const cleanupDirectory = artifactPath(text(cleanup.stdout));
    const cleanupStatus = JSON.parse(
      readFileSync(join(cleanupDirectory, "status.json"), "utf8"),
    );
    expect(cleanupStatus.retention.cleanupThresholdBytes).toBe(1);
    const retained = existsSync(activeDirectory);
    const transcript = retained
      ? readFileSync(join(activeDirectory, "stdout.log"), "utf8")
      : undefined;

    process.kill(active.pid, "SIGTERM");
    const exitCode = await exitWithin(active, 1_500);
    if (exitCode === undefined) {
      stopProcess(active.pid);
    }
    expect(retained).toBe(true);
    expect(
      statSync(join(activeDirectory, "status.json")).size +
        statSync(join(cleanupDirectory, "status.json")).size,
    ).toBeGreaterThan(1);
    expect(transcript).toBe("active-transcript");
    expect(exitCode).toBe(137);
    const finalStatus = JSON.parse(
      readFileSync(join(activeDirectory, "status.json"), "utf8"),
    );
    expect(finalStatus.lifecycle.completedAt).toBeString();
    expect(finalStatus.lifecycle.exitCode).toBe(137);
    expect(finalStatus.lifecycle.cancellationSignal).toBe("SIGTERM");
    expect(finalStatus.lifecycle.cleanup).toBe("killed");
  });
});
