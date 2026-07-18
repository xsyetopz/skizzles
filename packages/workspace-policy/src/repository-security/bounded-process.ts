// biome-ignore-all lint/style/useNamingConvention: Environment variable names follow external process contracts.
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
const PROCESS_GROUP_CLEANUP_TIMEOUT_MS = 1_000;
const PROCESS_GROUP_POLL_INTERVAL_MS = 10;
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
  label: string;
}

interface BoundedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runBoundedCommand(
  executable: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimitBytes =
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  if (timeoutMs <= 0 || outputLimitBytes <= 0) {
    throw new Error(`${options.label} command limits must be positive`);
  }

  const command = [executable, ...args];
  const spawnOptions = {
    stdin: "ignore" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    detached: process.platform !== "win32",
  };
  const cwd = options.cwd;
  const env = options.env;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  if (cwd === undefined) {
    if (env === undefined) {
      child = Bun.spawn(command, spawnOptions);
    } else {
      child = Bun.spawn(command, { ...spawnOptions, env });
    }
  } else {
    if (env === undefined) {
      child = Bun.spawn(command, { ...spawnOptions, cwd });
    } else {
      child = Bun.spawn(command, { ...spawnOptions, cwd, env });
    }
  }

  let termination: "timeout" | "output-limit" | undefined;
  const terminate = (reason: "timeout" | "output-limit"): void => {
    termination ??= reason;
    terminateProcessTree(child.pid);
  };
  const timer = setTimeout(() => terminate("timeout"), timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, outputLimitBytes, () =>
        terminate("output-limit"),
      ),
      readBounded(child.stderr, outputLimitBytes, () =>
        terminate("output-limit"),
      ),
    ]);
    if (termination !== undefined) {
      await requireProcessTreeExit(child.pid, options.label);
    } else if (processGroupPresent(child.pid)) {
      terminateProcessTree(child.pid);
      await requireProcessTreeExit(child.pid, options.label);
      throw new Error(`${options.label} left a descendant process running`);
    }
    if (termination === "timeout") {
      throw new Error(`${options.label} exceeded its ${timeoutMs}ms timeout`);
    }
    if (termination === "output-limit") {
      throw new Error(
        `${options.label} exceeded its ${outputLimitBytes}-byte output limit`,
      );
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  overflow: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > limit) {
        overflow();
        await reader.cancel();
        break;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let retainedBytes = total;
  if (total > limit) {
    retainedBytes = 0;
  }
  const bytes = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function terminateProcessTree(pid: number): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch (error) {
      if (!isNoSuchProcess(error)) {
        throw error;
      }
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error;
    }
  }
}

async function requireProcessTreeExit(
  pid: number,
  label: string,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const deadline = Date.now() + PROCESS_GROUP_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processGroupPresent(pid)) {
      return;
    }
    await Bun.sleep(PROCESS_GROUP_POLL_INTERVAL_MS);
  }
  throw new Error(`${label} process-group cleanup could not be verified`);
}

function processGroupPresent(pid: number): boolean {
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    throw error;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

export type { BoundedCommandOptions, BoundedCommandResult };
export { REPOSITORY_TOOL_ENV, runBoundedCommand };
