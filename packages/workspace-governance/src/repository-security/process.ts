// biome-ignore-all lint/style/useNamingConvention: Environment variable names follow external process contracts.

import { mkdir } from "node:fs/promises";
import process from "node:process";
import type { RunWorkspace } from "@skizzles/scratchspace";
import {
  type SupervisorOutcome,
  spawnCommandSupervisor,
} from "./process-supervisor.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
const REPOSITORY_TOOL_ENV = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  NO_COLOR: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
} as const;

interface BoundedCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  outputLimitBytes?: number;
  fileCreationMask?: number;
  label: string;
}

interface BoundedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runBoundedCommand(
  workspace: RunWorkspace,
  executable: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  assertOwnedProcessScopesSupported(process.platform);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimitBytes =
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  validateLimits(options, timeoutMs, outputLimitBytes);
  const commandTemp = workspace.path(
    "process-tmp",
    globalThis.crypto.randomUUID(),
  );
  await mkdir(commandTemp, { recursive: true, mode: 0o700 });
  const environment = {
    ...(options.env ?? process.env),
    TMPDIR: commandTemp,
    TMP: commandTemp,
    TEMP: commandTemp,
  };
  const supervisor = spawnWithMask(workspace, [executable, ...args], {
    ...options,
    env: environment,
  });
  try {
    workspace.registerChild(supervisor.child);
  } catch (error) {
    supervisor.stop("SIGKILL");
    await supervisor.child.waitForExit();
    throw error;
  }

  let termination: "cancelled" | "output-limit" | "timeout" | undefined;
  let terminationFailure: unknown;
  const terminated = Promise.withResolvers<void>();
  const streams = new AbortController();
  const terminate = (reason: typeof termination): void => {
    if (reason === undefined || termination !== undefined) return;
    termination = reason;
    streams.abort();
    try {
      supervisor.stop("SIGKILL");
    } catch (error) {
      terminationFailure = error;
    }
    terminated.resolve();
  };
  const cancel = (): void => terminate("cancelled");
  workspace.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => terminate("timeout"), timeoutMs);
  const stdout = readBounded(
    supervisor.process.stdout,
    outputLimitBytes,
    () => terminate("output-limit"),
    streams.signal,
  );
  const stderr = readBounded(
    supervisor.process.stderr,
    outputLimitBytes,
    () => terminate("output-limit"),
    streams.signal,
  );
  let outcome: SupervisorOutcome | undefined;
  let protocolFailure: unknown;
  try {
    const event = await Promise.race([
      supervisor.outcome.then(
        (value) => ({ type: "outcome" as const, value }),
        (error: unknown) => ({ type: "protocol-failure" as const, error }),
      ),
      supervisor.process.exited.then(() => ({
        type: "supervisor-exit" as const,
      })),
      terminated.promise.then(() => ({ type: "termination" as const })),
    ]);
    if (event.type === "outcome") {
      outcome = event.value;
    } else if (event.type === "protocol-failure") {
      protocolFailure = event.error;
    } else if (event.type === "supervisor-exit" && termination === undefined) {
      protocolFailure = new Error(
        `${options.label} supervisor exited before reporting status`,
      );
    }
    if (termination === undefined && protocolFailure === undefined) {
      supervisor.stop("SIGKILL");
    } else if (termination === undefined) {
      try {
        supervisor.stop("SIGKILL");
      } catch (error) {
        terminationFailure = error;
      }
    }
    await supervisor.child.waitForExit();
    streams.abort();
    const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
    supervisor.confirmExit();
    throwForFailure(
      options.label,
      timeoutMs,
      outputLimitBytes,
      termination,
      terminationFailure ?? protocolFailure,
      outcome,
    );
    return {
      exitCode: outcome.exitCode,
      stdout: stdoutText,
      stderr: stderrText,
    };
  } finally {
    clearTimeout(timer);
    workspace.signal.removeEventListener("abort", cancel);
    streams.abort();
  }
}

function spawnWithMask(
  workspace: RunWorkspace,
  command: readonly string[],
  options: BoundedCommandOptions,
): ReturnType<typeof spawnCommandSupervisor> {
  let previousMask: number | undefined;
  if (options.fileCreationMask !== undefined) {
    previousMask = process.umask(options.fileCreationMask);
  }
  try {
    return spawnCommandSupervisor(command, {
      ...options,
      statusPath: workspace.path(
        `.supervisor-${globalThis.crypto.randomUUID()}.json`,
      ),
    });
  } finally {
    if (previousMask !== undefined) process.umask(previousMask);
  }
}

function validateLimits(
  options: BoundedCommandOptions,
  timeoutMs: number,
  outputLimitBytes: number,
): void {
  if (timeoutMs <= 0 || outputLimitBytes <= 0) {
    throw new Error(`${options.label} command limits must be positive`);
  }
  const mask = options.fileCreationMask;
  if (
    mask !== undefined &&
    (!Number.isInteger(mask) || mask < 0 || mask > 0o777)
  ) {
    throw new Error(
      `${options.label} file creation mask must be an octal mode`,
    );
  }
}

function throwForFailure(
  label: string,
  timeoutMs: number,
  outputLimitBytes: number,
  termination: "cancelled" | "output-limit" | "timeout" | undefined,
  protocolFailure: unknown,
  outcome: SupervisorOutcome | undefined,
): asserts outcome is Extract<SupervisorOutcome, { type: "exited" }> {
  if (termination === "timeout") {
    throw new Error(`${label} exceeded its ${timeoutMs}ms timeout`);
  }
  if (termination === "output-limit") {
    throw new Error(
      `${label} exceeded its ${outputLimitBytes}-byte output limit`,
    );
  }
  if (termination === "cancelled") {
    throw new Error(`${label} was cancelled`);
  }
  if (protocolFailure !== undefined || outcome === undefined) {
    throw new Error(`${label} supervisor lifecycle failed`, {
      cause: protocolFailure,
    });
  }
  if (outcome.type === "spawn-error") {
    throw new Error(`${label} command could not start`);
  }
  if (outcome.type === "tool-error") {
    throw new Error(`${label} command status could not be determined`);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  overflow: () => void,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        overflow();
        await reader.cancel();
        break;
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (total > limit) return "";
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function assertOwnedProcessScopesSupported(
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") {
    throw new Error(
      "repository security tools require owned process scopes; Windows Job Object support is unavailable",
    );
  }
}

export type { BoundedCommandOptions, BoundedCommandResult };
export { REPOSITORY_TOOL_ENV };
