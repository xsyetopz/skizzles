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
    expect(initialStatus.completedAt).toBeUndefined();

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
    expect(transcript).toBe("active-transcript");
    expect(exitCode).toBe(137);
    const finalStatus = JSON.parse(
      readFileSync(join(activeDirectory, "status.json"), "utf8"),
    );
    expect(finalStatus.completedAt).toBeString();
    expect(finalStatus.exitCode).toBe(137);
  });
});
