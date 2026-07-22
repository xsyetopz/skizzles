import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import type { RunSettings } from "../../src/codex-command/contract.ts";
import {
  completeRun,
  createRunStatus,
  syncRunEvidence,
} from "../../src/codex-command/run/status.ts";
import {
  parseRunStatus,
  serializeRunStatus,
} from "../../src/codex-command/run/status-codec.ts";
import { emptyCaptureState } from "../../src/codex-command/stream-capture.ts";

export const packageRoot = resolve(import.meta.dir, "../..");
export const runner = join(packageRoot, "src/codex-command.ts");
export const artifactPathPattern = /\[codex-command\] artifact: ([^\n]+)/u;
export const artifactCountPattern = /\[codex-command\] artifact:/gu;
export const progressPattern = /\| \d+s \| \d+B \| \d+B \|/u;
export const completionPattern = /\[codex-command\] exit 0 in \d+s\n$/u;
export const generatedRunIdPattern = /^[a-f0-9]{12}$/u;
const fixtureSettings: RunSettings = {
  root: "/tmp/codex-command-fixture",
  maximumBytes: 1024 * 1024,
  maximumDiskBytes: 1024 * 1024,
  heartbeatMilliseconds: 30_000,
  drainMilliseconds: 750,
  inlineBytes: 10 * 1024,
  signalGraceMilliseconds: 750,
};

export interface RunnerFixture {
  cleanupTemporaryDirectories: () => void;
  temporaryDirectory: () => string;
}

export function createRunnerFixture(): RunnerFixture {
  const temporaryDirectories = new Set<string>();
  return {
    cleanupTemporaryDirectories(): void {
      for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
      temporaryDirectories.clear();
    },
    temporaryDirectory(): string {
      const directory = mkdtempSync(join(tmpdir(), "codex-command-test-"));
      temporaryDirectories.add(directory);
      return directory;
    },
  };
}

export function invoke(
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

export function text(output: Uint8Array | undefined): string {
  return new TextDecoder().decode(output);
}

export function encode(script: string): string {
  return Buffer.from(script).toString("base64url");
}

export function artifactPath(output: string): string {
  const path = output.match(artifactPathPattern)?.[1];
  if (!path) {
    throw new Error(`artifact path missing from output: ${output}`);
  }
  return path;
}

export async function waitForFile(path: string, timeoutMilliseconds = 2000) {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    if (await Bun.file(path).exists()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

export function exitWithin(
  subprocess: Bun.Subprocess,
  timeoutMilliseconds: number,
): Promise<number | undefined> {
  return Promise.race([
    subprocess.exited,
    Bun.sleep(timeoutMilliseconds).then(() => undefined),
  ]);
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(
  pid: number,
  timeoutMilliseconds = 1000,
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

export function stopProcess(pid: number): void {
  if (!processExists(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the existence check and signal delivery.
  }
}

export function spawnRunner(
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

export async function waitForRunDirectory(
  root: string,
  timeoutMilliseconds = 2000,
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

export function writeCompletedRun(
  root: string,
  id: string,
  stdout: string,
): string {
  const directory = join(root, id);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "stdout.log"), stdout, { mode: 0o600 });
  writeFileSync(join(directory, "stderr.log"), "", { mode: 0o600 });
  const stdoutState = emptyCaptureState();
  stdoutState.observedBytes = Buffer.byteLength(stdout);
  stdoutState.storedBytes = stdoutState.observedBytes;
  stdoutState.retainedSha256.update(stdout);
  const stderrState = emptyCaptureState();
  const status = createRunStatus({
    id,
    script: "completed fixture",
    shell: "/bin/sh",
    settings: fixtureSettings,
    artifactCapture: "active",
  });
  syncRunEvidence(status, stdoutState, stderrState);
  completeRun(status, {
    exitCode: 0,
    signal: undefined,
    drainedNaturally: true,
    cleanup: "not-required",
  });
  writeFileSync(join(directory, "status.json"), serializeRunStatus(status), {
    mode: 0o600,
  });
  return directory;
}

export function exactStatus(content: string, id: string) {
  return parseRunStatus(content, id);
}

export async function queryStatus(root: string, id: string) {
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
