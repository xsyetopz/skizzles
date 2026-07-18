// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  artifactPath,
  exitWithin,
  spawnRunner,
  stopProcess,
  temporaryDirectory,
  waitForFile,
  waitForProcessExit,
} from "./runner-fixture.ts";

describe("signal forwarding and descendant supervision", () => {
  it("forwards SIGTERM to the shell and records its handled exit", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = temporaryDirectory();
    const shellPidPath = join(root, "shell.pid");
    const child = spawnRunner(
      `trap 'printf handled >&2; exit 42' TERM; printf %s $$ > '${shellPidPath}'; while :; do :; done`,
      join(root, "artifacts"),
      { CODEX_COMMAND_SIGNAL_GRACE_MS: "250" },
    );
    await waitForFile(shellPidPath);
    const shellPid = Number.parseInt(readFileSync(shellPidPath, "utf8"), 10);
    process.kill(child.pid, "SIGTERM");
    const exitCode = await exitWithin(child, 1_500);
    if (exitCode === undefined) {
      stopProcess(shellPid);
      stopProcess(child.pid);
    }

    expect(exitCode).toBe(42);
    const output = await new Response(child.stdout).text();
    const directory = artifactPath(output);
    const status = JSON.parse(
      readFileSync(join(directory, "status.json"), "utf8"),
    );
    expect(status.signal).toBe("SIGTERM");
    expect(status.exitCode).toBe(42);
    expect(readFileSync(join(directory, "stderr.log"), "utf8")).toBe("handled");
  });

  it("escalates a signal-ignoring shell without hanging the supervisor", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = temporaryDirectory();
    const shellPidPath = join(root, "shell.pid");
    const child = spawnRunner(
      `trap '' TERM; printf %s $$ > '${shellPidPath}'; while :; do sleep 1; done`,
      join(root, "artifacts"),
      { CODEX_COMMAND_SIGNAL_GRACE_MS: "100" },
    );
    await waitForFile(shellPidPath);
    const shellPid = Number.parseInt(readFileSync(shellPidPath, "utf8"), 10);
    process.kill(child.pid, "SIGTERM");
    const exitCode = await exitWithin(child, 1_500);
    if (exitCode === undefined) {
      stopProcess(shellPid);
      stopProcess(child.pid);
    }

    expect(exitCode).toBe(137);
    expect(await waitForProcessExit(shellPid)).toBe(true);
    const output = await new Response(child.stdout).text();
    const status = JSON.parse(
      readFileSync(join(artifactPath(output), "status.json"), "utf8"),
    );
    expect(status.signal).toBe("SIGTERM");
    expect(status.exitCode).toBe(137);
  });

  it("uses a repeated supervisor signal as immediate escalation", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = temporaryDirectory();
    const shellPidPath = join(root, "shell.pid");
    const child = spawnRunner(
      `trap '' TERM INT; printf %s $$ > '${shellPidPath}'; while :; do sleep 1; done`,
      join(root, "artifacts"),
      { CODEX_COMMAND_SIGNAL_GRACE_MS: "2000" },
    );
    await waitForFile(shellPidPath);
    process.kill(child.pid, "SIGTERM");
    await Bun.sleep(25);
    process.kill(child.pid, "SIGINT");
    const exitCode = await exitWithin(child, 750);
    if (exitCode === undefined) {
      stopProcess(Number.parseInt(readFileSync(shellPidPath, "utf8"), 10));
      stopProcess(child.pid);
    }

    expect(exitCode).toBe(137);
    const output = await new Response(child.stdout).text();
    const status = JSON.parse(
      readFileSync(join(artifactPath(output), "status.json"), "utf8"),
    );
    expect(status.signal).toBe("SIGTERM");
  });

  it("handles SIGTERM during post-shell drain and finalizes coherent artifacts", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = temporaryDirectory();
    const shellPidPath = join(root, "exited-shell.pid");
    const descendantPidPath = join(root, "draining-descendant.pid");
    const script = `printf %s $$ > '${shellPidPath}'; printf shell-output; /bin/sh -c 'trap "" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' &`;
    const child = spawnRunner(script, join(root, "artifacts"), {
      CODEX_COMMAND_DRAIN_MS: "5000",
      CODEX_COMMAND_SIGNAL_GRACE_MS: "100",
    });
    await waitForFile(shellPidPath);
    await waitForFile(descendantPidPath);
    const shellPid = Number.parseInt(readFileSync(shellPidPath, "utf8"), 10);
    const descendantPid = Number.parseInt(
      readFileSync(descendantPidPath, "utf8"),
      10,
    );
    expect(await waitForProcessExit(shellPid)).toBe(true);

    process.kill(child.pid, "SIGTERM");
    const exitCode = await exitWithin(child, 1_500);
    const descendantExited = await waitForProcessExit(descendantPid);
    if (!descendantExited) {
      stopProcess(descendantPid);
    }
    if (exitCode === undefined) {
      stopProcess(child.pid);
    }

    expect(exitCode).toBe(143);
    expect(descendantExited).toBe(true);
    const output = await new Response(child.stdout).text();
    const directory = artifactPath(output);
    const status = JSON.parse(
      readFileSync(join(directory, "status.json"), "utf8"),
    );
    expect(status.signal).toBe("SIGTERM");
    expect(status.exitCode).toBe(143);
    expect(status.completedAt).toBeString();
    expect(status.drainIncomplete).toBe(false);
    expect(readFileSync(join(directory, "stdout.log"), "utf8")).toBe(
      "shell-output",
    );
    expect(statSync(join(directory, "status.json")).mode & 0o777).toBe(0o600);
  });

  for (const [signal, expectedExitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 1],
  ] as const) {
    it(`terminates signal-ignoring descendants after ${signal}`, async () => {
      if (process.platform === "win32") {
        return;
      }
      const root = temporaryDirectory();
      const descendantPidPath = join(root, "descendant.pid");
      const script = `/bin/sh -c 'trap "" HUP INT TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' </dev/null >/dev/null 2>/dev/null & wait`;
      const child = spawnRunner(script, join(root, "artifacts"), {
        CODEX_COMMAND_SIGNAL_GRACE_MS: "100",
      });
      await waitForFile(descendantPidPath);
      const descendantPid = Number.parseInt(
        readFileSync(descendantPidPath, "utf8"),
        10,
      );
      process.kill(child.pid, signal);
      const exitCode = await exitWithin(child, 1_500);
      const descendantExited = await waitForProcessExit(descendantPid);
      if (!descendantExited) {
        stopProcess(descendantPid);
      }
      if (exitCode === undefined) {
        stopProcess(child.pid);
      }

      expect(exitCode).toBe(expectedExitCode);
      expect(descendantExited).toBe(true);
      const output = await new Response(child.stdout).text();
      const status = JSON.parse(
        readFileSync(join(artifactPath(output), "status.json"), "utf8"),
      );
      expect(status.signal).toBe(signal);
      expect(status.exitCode).toBe(expectedExitCode);
    });
  }
});
