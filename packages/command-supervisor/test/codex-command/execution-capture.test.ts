// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  artifactPath,
  encode,
  exitWithin,
  invoke,
  progressPattern,
  runner,
  spawnRunner,
  stopProcess,
  temporaryDirectory,
  text,
  waitForFile,
  waitForProcessExit,
} from "./runner-fixture.ts";

describe("command execution and stream capture", () => {
  it("preserves exit code and captures externally visible output", () => {
    const root = temporaryDirectory();
    const result = invoke(
      runner,
      ["run", "--base64url", encode("echo visible; echo failure >&2; exit 23")],
      { env: { CODEX_COMMAND_OUTPUT_DIR: root } },
    );
    expect(result.exitCode).toBe(23);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toContain("visible");
    expect(readFileSync(join(path, "stderr.log"), "utf8")).toContain("failure");
    const status = JSON.parse(readFileSync(join(path, "status.json"), "utf8"));
    expect(status.exitCode).toBe(23);
    expect(status.stdoutObservedBytes).toBe(8);
    expect(status.stdoutStoredBytes).toBe(8);
    expect(Object.keys(status)).toEqual([
      "id",
      "command",
      "startedAt",
      "shell",
      "stdoutObservedBytes",
      "stderrObservedBytes",
      "stdoutStoredBytes",
      "stderrStoredBytes",
      "stdoutTruncated",
      "stderrTruncated",
      "artifactCapture",
      "drainIncomplete",
      "completedAt",
      "exitCode",
    ]);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(path, "stdout.log")).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "stderr.log")).mode & 0o777).toBe(0o600);
  });

  it("keeps explicit shell redirections out of captured output", () => {
    const root = temporaryDirectory();
    const redirected = join(root, "redirected.txt");
    const result = invoke(
      runner,
      [
        "run",
        "--base64url",
        encode(`echo redirected > '${redirected}'; echo captured`),
      ],
      { env: { CODEX_COMMAND_OUTPUT_DIR: root } },
    );
    expect(result.exitCode).toBe(0);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(redirected, "utf8")).toBe("redirected\n");
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toBe("captured\n");
  });

  it("keeps inherited stdin available to the detached shell", () => {
    const root = temporaryDirectory();
    const result = invoke(
      runner,
      [
        "run",
        "--base64url",
        encode('IFS= read -r value; printf "received:%s" "$value"'),
      ],
      {
        stdin: "piped-input\n",
        env: { CODEX_COMMAND_OUTPUT_DIR: root },
      },
    );
    expect(result.exitCode).toBe(0);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toBe(
      "received:piped-input",
    );
  });

  it("caps artifacts and emits heartbeat status", () => {
    const root = temporaryDirectory();
    const result = invoke(
      runner,
      [
        "run",
        "--base64url",
        encode("for i in 1 2 3; do printf 1234567890; sleep 0.04; done"),
      ],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: root,
          CODEX_COMMAND_MAX_BYTES: "12",
          CODEX_COMMAND_HEARTBEAT_MS: "25",
        },
      },
    );
    const path = artifactPath(text(result.stdout));
    const status = JSON.parse(readFileSync(join(path, "status.json"), "utf8"));
    expect(readFileSync(join(path, "stdout.log")).length).toBe(12);
    expect(status.stdoutObservedBytes).toBe(30);
    expect(status.stdoutStoredBytes).toBe(12);
    expect(status.stdoutTruncated).toBe(true);
    expect(text(result.stdout)).toMatch(progressPattern);
  });

  it("bounds drain time when a background process keeps output descriptors open", () => {
    const root = temporaryDirectory();
    const startedAt = performance.now();
    const result = invoke(runner, ["run", "--base64url", encode("sleep 2 &")], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root, CODEX_COMMAND_DRAIN_MS: "25" },
    });
    expect(result.exitCode).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(500);
    const path = artifactPath(text(result.stdout));
    const status = JSON.parse(readFileSync(join(path, "status.json"), "utf8"));
    expect(status.drainIncomplete).toBe(true);
  });

  it("settles background descendants after a normal shell exit", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = temporaryDirectory();
    const descendantPidPath = join(root, "normal-exit-descendant.pid");
    const child = spawnRunner(
      `printf shell-output; /bin/sh -c 'trap "" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' &`,
      join(root, "artifacts"),
      {
        CODEX_COMMAND_DRAIN_MS: "50",
        CODEX_COMMAND_SIGNAL_GRACE_MS: "50",
      },
    );
    await waitForFile(descendantPidPath);
    const descendantPid = Number.parseInt(
      readFileSync(descendantPidPath, "utf8"),
      10,
    );
    const exitCode = await exitWithin(child, 1_500);
    const descendantExited = await waitForProcessExit(descendantPid, 500);
    if (!descendantExited) {
      stopProcess(descendantPid);
    }
    if (exitCode === undefined) {
      stopProcess(child.pid);
    }

    expect(exitCode).toBe(0);
    expect(descendantExited).toBe(true);
    const output = await new Response(child.stdout).text();
    const directory = artifactPath(output);
    const status = JSON.parse(
      readFileSync(join(directory, "status.json"), "utf8"),
    );
    expect(status.exitCode).toBe(0);
    expect(status.completedAt).toBeString();
    expect(status.drainIncomplete).toBe(true);
    expect(readFileSync(join(directory, "stdout.log"), "utf8")).toBe(
      "shell-output",
    );
    expect(readdirSync(directory).sort()).toEqual([
      "status.json",
      "stderr.log",
      "stdout.log",
    ]);
  });

  it("runs even when artifact setup fails", () => {
    const root = temporaryDirectory();
    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "file");
    chmodSync(blocked, 0o400);
    const result = invoke(
      runner,
      [
        "run",
        "--base64url",
        encode("echo still-runs; echo visible-error >&2; exit 7"),
      ],
      { env: { CODEX_COMMAND_OUTPUT_DIR: blocked } },
    );
    expect(result.exitCode).toBe(7);
    expect(text(result.stderr)).toContain("artifact capture unavailable");
    expect(text(result.stdout)).toContain("artifact: unavailable");
    expect(text(result.stdout)).toContain("still-runs");
    expect(text(result.stderr)).toContain("visible-error");
  });
});
