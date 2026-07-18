// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const packageRoot = resolve(import.meta.dir, "..");
const runner = join(packageRoot, "src/codex-command.ts");
const temporaryDirectories: string[] = [];
const artifactPathPattern = /\[codex-command\] artifact: ([^\n]+)/;
const artifactCountPattern = /\[codex-command\] artifact:/g;
const progressPattern = /\| \d+s \| \d+B \| \d+B \|/;
const completionPattern = /\[codex-command\] exit 0 in \d+s\n$/;
const generatedRunIdPattern = /^[a-f0-9]{12}$/;
const activeStatusKeys = [
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
];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-command-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function invoke(
  executable: string,
  arguments_: string[],
  options: { stdin?: string; env?: Record<string, string | undefined> } = {},
) {
  return Bun.spawnSync(["bun", executable, ...arguments_], {
    stdin: options.stdin ? new TextEncoder().encode(options.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
}

function text(output: Uint8Array | undefined): string {
  return new TextDecoder().decode(output);
}

function encode(script: string): string {
  return Buffer.from(script).toString("base64url");
}

function artifactPath(output: string): string {
  const path = output.match(artifactPathPattern)?.[1];
  if (!path) {
    throw new Error(`artifact path missing from output: ${output}`);
  }
  return path;
}

async function waitForFile(path: string, timeoutMilliseconds = 2_000) {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    if (await Bun.file(path).exists()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function exitWithin(
  subprocess: Bun.Subprocess,
  timeoutMilliseconds: number,
): Promise<number | undefined> {
  return Promise.race([
    subprocess.exited,
    Bun.sleep(timeoutMilliseconds).then(() => undefined),
  ]);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMilliseconds = 1_000,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    if (!processExists(pid)) {
      return true;
    }
    await Bun.sleep(10);
  }
  return !processExists(pid);
}

function stopProcess(pid: number): void {
  if (!processExists(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the existence check and signal delivery.
  }
}

function spawnRunner(
  script: string,
  root: string,
  env: Record<string, string> = {},
) {
  return Bun.spawn(["bun", runner, "run", "--base64url", encode(script)], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CODEX_COMMAND_OUTPUT_DIR: root,
      ...env,
    },
  });
}

async function waitForRunDirectory(
  root: string,
  timeoutMilliseconds = 2_000,
): Promise<string> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    if (existsSync(root)) {
      const id = readdirSync(root).find((entry) =>
        generatedRunIdPattern.test(entry),
      );
      if (id && existsSync(join(root, id, "status.json"))) {
        return join(root, id);
      }
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for run directory in ${root}`);
}

function writeCompletedRun(root: string, id: string, stdout: string): string {
  const directory = join(root, id);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "stdout.log"), stdout, { mode: 0o600 });
  writeFileSync(join(directory, "stderr.log"), "", { mode: 0o600 });
  const status = {
    id,
    command: "completed fixture",
    startedAt: "2026-01-01T00:00:00.000Z",
    shell: "/bin/sh",
    stdoutObservedBytes: Buffer.byteLength(stdout),
    stderrObservedBytes: 0,
    stdoutStoredBytes: Buffer.byteLength(stdout),
    stderrStoredBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    artifactCapture: "active",
    drainIncomplete: false,
    completedAt: "2026-01-01T00:00:01.000Z",
    exitCode: 0,
  };
  writeFileSync(join(directory, "status.json"), `${JSON.stringify(status)}\n`, {
    mode: 0o600,
  });
  return directory;
}

function exactStatus(content: string): Record<string, unknown> {
  if (content.length === 0) {
    throw new Error("status snapshot was empty");
  }
  const status = JSON.parse(content) as Record<string, unknown>;
  const keys = Object.keys(status);
  const validKeys =
    JSON.stringify(keys) === JSON.stringify(activeStatusKeys) ||
    JSON.stringify(keys) ===
      JSON.stringify([...activeStatusKeys, "completedAt", "exitCode"]);
  if (!validKeys) {
    throw new Error(`unexpected status keys: ${keys.join(",")}`);
  }
  if (typeof status["id"] !== "string") {
    throw new Error("status id missing");
  }
  if (typeof status["command"] !== "string") {
    throw new Error("status command missing");
  }
  if (typeof status["startedAt"] !== "string") {
    throw new Error("status startedAt missing");
  }
  if (status["artifactCapture"] !== "active") {
    throw new Error("status artifactCapture is not active");
  }
  return status;
}

async function queryStatus(root: string, id: string) {
  const child = Bun.spawn(["bun", runner, "status", id], {
    env: { ...process.env, CODEX_COMMAND_OUTPUT_DIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  return { exitCode, stdout: await stdout, stderr: await stderr };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed command output runner", () => {
  test("preserves exit code and captures externally visible output", () => {
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

  test("keeps explicit shell redirections out of captured output", () => {
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

  test("keeps inherited stdin available to the detached shell", () => {
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

  test("caps artifacts and emits heartbeat status", () => {
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

  test("bounds drain time when a background process keeps output descriptors open", () => {
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

  test("settles background descendants after a normal shell exit", async () => {
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

  test("runs even when artifact setup fails", () => {
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

  test("rejects a symlink output root without mutating its target", () => {
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

  test("rejects a non-owner-only output root without changing its mode", () => {
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

  test("retention removes only validated completed runs and preserves foreign directories", () => {
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

  test("retention cannot delete an active concurrent run", async () => {
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

  test("uses the invoking zsh and supports process substitution", () => {
    if (Bun.file("/bin/zsh").size === 0) {
      return;
    }
    const root = temporaryDirectory();
    const result = invoke(
      runner,
      ["run", "--base64url", encode("cat <(printf process-substitution)")],
      { env: { CODEX_COMMAND_OUTPUT_DIR: root, SHELL: "/bin/zsh" } },
    );
    expect(result.exitCode).toBe(0);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toBe(
      "process-substitution",
    );
    expect(
      JSON.parse(readFileSync(join(path, "status.json"), "utf8")).shell,
    ).toBe("/bin/zsh");
  });

  test("prints one artifact path, change-only progress, full small output, and compact completion", () => {
    const root = temporaryDirectory();
    const result = invoke(
      runner,
      [
        "run",
        "--base64url",
        encode("sleep 0.08; printf compact; printf warning >&2"),
      ],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: root,
          CODEX_COMMAND_HEARTBEAT_MS: "25",
        },
      },
    );
    const output = text(result.stdout);
    expect(output.match(artifactCountPattern)).toHaveLength(1);
    expect(output).toContain("| seconds | out | err |");
    expect(output).toContain("[codex-command] stdout:\ncompact");
    expect(output).toContain("[codex-command] stderr:\nwarning");
    expect(output).toMatch(completionPattern);
    expect(output).not.toContain("observed");
    expect(output).not.toContain("stored");
  });

  test("prints tails instead of the full transcript above the inline threshold", () => {
    const root = temporaryDirectory();
    const result = invoke(
      runner,
      ["run", "--base64url", encode("printf 1234567890")],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: root,
          CODEX_COMMAND_INLINE_BYTES: "5",
        },
      },
    );
    const output = text(result.stdout);
    expect(output).toContain("[codex-command] stdout tail:\n1234567890");
    expect(output).not.toContain("[codex-command] stdout:\n");
    expect(output.match(artifactCountPattern)).toHaveLength(1);
  });

  test("serves exact status, tail, errors, and search queries from retained artifacts", () => {
    const root = temporaryDirectory();
    const run = invoke(
      runner,
      [
        "run",
        "--base64url",
        encode("printf 'alpha\\nbeta\\n'; printf 'warning marker\\n' >&2"),
      ],
      { env: { CODEX_COMMAND_OUTPUT_DIR: root } },
    );
    const directory = artifactPath(text(run.stdout));
    const id = directory.split("/").at(-1);
    if (!id) {
      throw new Error(`run id missing from ${directory}`);
    }
    const statusPath = join(directory, "status.json");

    const status = invoke(runner, ["status", id], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(status.exitCode).toBe(0);
    expect(text(status.stdout)).toBe(readFileSync(statusPath, "utf8"));
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);

    const stdoutTail = invoke(runner, ["tail", id], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(text(stdoutTail.stdout)).toBe("alpha\nbeta\n");

    const errors = invoke(runner, ["errors", id], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(text(errors.stdout)).toBe("warning marker\n");

    const search = invoke(runner, ["search", "marker", id], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(text(search.stdout)).toBe(`${directory}/stderr.log\n`);
  });

  test("status queries observe only complete atomic heartbeat snapshots", async () => {
    const root = temporaryDirectory();
    const longComment = "x".repeat(32 * 1024);
    const script = `# ${longComment}\nfor i in {1..160}; do printf x; sleep 0.015; done`;
    const run = spawnRunner(script, root, {
      CODEX_COMMAND_HEARTBEAT_MS: "25",
    });
    const directory = await waitForRunDirectory(root);
    const id = directory.split("/").at(-1);
    if (!id) {
      throw new Error(`run id missing from ${directory}`);
    }
    const statusPath = join(directory, "status.json");

    for (let batch = 0; batch < 20; batch += 1) {
      for (let read = 0; read < 50; read += 1) {
        exactStatus(readFileSync(statusPath, "utf8"));
      }
      const responses = await Promise.all(
        Array.from({ length: 12 }, () => queryStatus(root, id)),
      );
      for (const response of responses) {
        expect(response.exitCode).toBe(0);
        expect(response.stderr).toBe("");
        exactStatus(response.stdout);
      }
      await Bun.sleep(5);
    }

    expect(await run.exited).toBe(0);
    exactStatus(readFileSync(statusPath, "utf8"));
    expect(readdirSync(directory).sort()).toEqual([
      "status.json",
      "stderr.log",
      "stdout.log",
    ]);
  }, 15_000);

  test("rejects malformed run IDs and query arguments without escaping the run store", () => {
    const root = temporaryDirectory();
    const cases = [
      ["status", ".."],
      ["tail", "../outside"],
      ["tail", "missing", "combined"],
      ["search", ""],
      ["search", "x".repeat(257)],
      ["run", "--base64url", "="],
      ["unknown"],
    ];
    for (const arguments_ of cases) {
      const result = invoke(runner, arguments_, {
        env: { CODEX_COMMAND_OUTPUT_DIR: root },
      });
      expect(result.exitCode, arguments_.join(" ")).toBe(64);
      expect(text(result.stderr).length, arguments_.join(" ")).toBeGreaterThan(
        0,
      );
    }
  });

  test("reports missing or malformed retained artifacts as query failures", () => {
    const root = temporaryDirectory();
    const missingStatus = join(root, "missing-status");
    mkdirSync(missingStatus, { mode: 0o700 });
    writeFileSync(join(missingStatus, "stdout.log"), "partial", {
      mode: 0o600,
    });
    const status = invoke(runner, ["status", "missing-status"], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(status.exitCode).toBe(64);
    expect(text(status.stderr)).toContain("status artifact unavailable");

    const missingRun = invoke(runner, ["tail", "does-not-exist"], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(missingRun.exitCode).toBe(64);
    expect(text(missingRun.stderr)).toContain("run not found: does-not-exist");

    const outside = temporaryDirectory();
    symlinkSync(outside, join(root, "linked-run"));
    const linkedRun = invoke(runner, ["tail", "linked-run"], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(linkedRun.exitCode).toBe(64);
    expect(text(linkedRun.stderr)).toContain("run not found: linked-run");
  });

  test("forwards SIGTERM to the shell and records its handled exit", async () => {
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

  test("escalates a signal-ignoring shell without hanging the supervisor", async () => {
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

  test("uses a repeated supervisor signal as immediate escalation", async () => {
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

  test("handles SIGTERM during post-shell drain and finalizes coherent artifacts", async () => {
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
    test(`terminates signal-ignoring descendants after ${signal}`, async () => {
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
