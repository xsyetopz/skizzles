import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  type DockerRunner,
  destroyLabStack,
  launchDockerRun,
  runtimeFromLab,
  terminateDockerRun,
} from "../docker.ts";
import { withFileLock } from "../locks.ts";
import { readLab, writeLab } from "../state/lab-store.ts";
import {
  activityLockPath,
  labLockPath,
  type StateRoots,
} from "../state/layout.ts";

const CWD_SEGMENT_SEPARATOR = /[\\/]/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RunOutput = {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  stdin?: NodeJS.ReadableStream;
};

type AttachedRunContext = {
  owner: string;
  roots: StateRoots;
  docker: DockerRunner;
  environment: NodeJS.ProcessEnv;
};

export async function runAttachedCommand(
  context: AttachedRunContext,
  id: string,
  argv: string[],
  cwd: string,
  environment: Record<string, string>,
  timeoutSeconds: number,
  output: RunOutput,
  signal?: AbortSignal,
): Promise<number> {
  validateAttachedRunRequest(argv, cwd, environment, timeoutSeconds);
  try {
    return await withFileLock(
      activityLockPath(context.roots.stateRoot, context.owner, id),
      async () =>
        await runLockedCommand(
          context,
          id,
          argv,
          cwd,
          environment,
          timeoutSeconds,
          output,
          signal,
        ),
      {
        attempts: 600,
        delayMs: 50,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    if (signal?.aborted) {
      return abortExitCode(signal);
    }
    throw error;
  }
}

async function runLockedCommand(
  context: AttachedRunContext,
  id: string,
  argv: string[],
  cwd: string,
  environment: Record<string, string>,
  timeoutSeconds: number,
  output: RunOutput,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) {
    return abortExitCode(signal);
  }
  const lab = await readLab(context.roots, context.owner, id);
  if (lab.state !== "ready") {
    throw new Error(`lab is not ready: ${lab.state}`);
  }
  const runtime = runtimeFromLab(lab);
  for (const key of Object.keys(environment)) {
    if (!runtime.config.forwardEnvironment.includes(key)) {
      throw new Error(
        `run environment is not declared by the manifest: ${key}`,
      );
    }
  }
  const identity = {
    runId: crypto.randomUUID(),
    cwd,
    argv,
    environment,
  };
  const child = launchDockerRun(
    runtime,
    identity,
    context.docker,
    context.environment,
  );
  child.stdout.on("data", output.stdout);
  child.stderr.on("data", output.stderr);
  output.stdin?.pipe(child.stdin);
  let requestedExit: number | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (exitCode: number, first: "INT" | "TERM") => {
    requestedExit ??= exitCode;
    stopping ??= stopAttachedCommand(
      context,
      id,
      runtime,
      identity,
      child,
      first,
    );
  };
  const onAbort = () =>
    stop(abortExitCode(signal), signal?.reason === "SIGINT" ? "INT" : "TERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }
  const timeout =
    timeoutSeconds > 0
      ? setTimeout(() => stop(124, "TERM"), timeoutSeconds * 1000)
      : undefined;
  try {
    const code = await onceClosed(child);
    if (stopping !== undefined) {
      await stopping;
    }
    return requestedExit ?? code;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    signal?.removeEventListener("abort", onAbort);
    output.stdin?.unpipe(child.stdin);
  }
}

async function stopAttachedCommand(
  context: AttachedRunContext,
  id: string,
  runtime: ReturnType<typeof runtimeFromLab>,
  identity: Parameters<typeof terminateDockerRun>[1],
  child: ChildProcessWithoutNullStreams,
  first: "INT" | "TERM",
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await terminateDockerRun(
      runtime,
      identity,
      first,
      context.docker,
    );
    if (result.confirmed) {
      break;
    }
    if (result.status !== "unavailable") {
      break;
    }
    await Bun.sleep(100);
  }
  await Promise.race([onceClosed(child), Bun.sleep(2_000)]);
  if (child.exitCode !== null) {
    return;
  }
  try {
    const final = await terminateDockerRun(
      runtime,
      identity,
      "KILL",
      context.docker,
    );
    if (!final.confirmed) {
      await destroyLabStack(runtime, context.docker);
      await withFileLock(
        labLockPath(context.roots.stateRoot, context.owner, id),
        async () => {
          const current = await readLab(context.roots, context.owner, id);
          if (current.state === "ready") {
            current.state = "failed";
            current.error =
              "attached command identity became uncertain; the exact lab stack was removed and must be recreated";
            current.updatedAt = new Date().toISOString();
            await writeLab(context.roots, current);
          }
        },
      );
    }
  } finally {
    child.kill("SIGKILL");
  }
}

function abortExitCode(signal: AbortSignal | undefined): 124 | 130 | 143 {
  return signal?.reason === "SIGINT"
    ? 130
    : signal?.reason === "SIGTERM"
      ? 143
      : 124;
}

export function validateAttachedRunRequest(
  argv: string[],
  cwd: string,
  environment: Record<string, string>,
  timeoutSeconds: number,
): void {
  if (
    argv.length === 0 ||
    argv.length > 256 ||
    argv.some((arg) => arg.includes("\0")) ||
    Buffer.byteLength(argv.join("\0")) > 64 * 1024
  ) {
    throw new Error("run argv must contain 1..256 bounded arguments");
  }
  if (
    cwd.includes("\0") ||
    (cwd !== "." &&
      (cwd.startsWith("/") || cwd.split(CWD_SEGMENT_SEPARATOR).includes("..")))
  ) {
    throw new Error("run cwd must be a relative path inside the workspace");
  }
  const entries = Object.entries(environment);
  if (
    entries.length > 64 ||
    entries.some(
      ([key, value]) => !ENVIRONMENT_NAME.test(key) || value.includes("\0"),
    ) ||
    Buffer.byteLength(JSON.stringify(environment)) > 64 * 1024
  ) {
    throw new Error("run environment is invalid or exceeds 64 KiB");
  }
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 0 ||
    timeoutSeconds > 7200
  ) {
    throw new Error("timeout-seconds must be 0..7200");
  }
}

function onceClosed(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
