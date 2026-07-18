import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import process from "node:process";
import type { LabConfig } from "./config.ts";
import {
  launchAttachedDockerProcess,
  terminateAttachedDockerProcess,
} from "./docker/attached-process.ts";
import {
  cleanupLabLabelsInDocker,
  destroyLabStackInDocker,
} from "./docker/cleanup.ts";
import {
  dockerAvailableInRuntime,
  prepareLabRuntimeInDocker,
  provisionLabStackInDocker,
  readStackLogs,
  readStackStatus,
  runComposeCommand,
  runtimeFromMetadata,
} from "./docker/runtime.ts";
import { type CommandResult, type RunOptions, runCommand } from "./process.ts";
import type {
  Endpoint,
  LabMetadata,
  PersistedLabRuntime,
} from "./state/lab/contract.ts";

export type LabRuntime = PersistedLabRuntime & { metadata: LabMetadata };

export interface DockerRunner {
  run(args: string[], options?: RunOptions): Promise<CommandResult>;
  spawn(
    args: string[],
    options?: DockerSpawnOptions,
  ): ChildProcessWithoutNullStreams;
}

export type DockerSpawnOptions = { env?: NodeJS.ProcessEnv };

export type DockerRunTerminationResult =
  | { confirmed: true; status: "signaled" | "absent" }
  | {
      confirmed: false;
      status: "identity-mismatch" | "unavailable" | "docker-failure";
    };

export const defaultDockerRunner: DockerRunner = {
  run: async (args, options = {}) => await runCommand("docker", args, options),
  spawn: (args, options = {}) =>
    spawn("docker", args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }),
};

export async function dockerAvailable(
  runner: DockerRunner = defaultDockerRunner,
  secretEnvironment: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return await dockerAvailableInRuntime(runner, secretEnvironment, environment);
}

export async function prepareLabRuntime(
  metadata: LabMetadata,
  config: LabConfig,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LabRuntime> {
  return await prepareLabRuntimeInDocker(metadata, config, runner, environment);
}

export async function composeCommand(
  runtime: LabRuntime,
  args: string[],
  options: {
    timeoutMs?: number;
    allowFailure?: boolean;
    signal?: AbortSignal;
  } = {},
  runner: DockerRunner = defaultDockerRunner,
): Promise<CommandResult> {
  return await runComposeCommand(runtime, args, options, runner);
}

export async function provisionLabStack(
  runtime: LabRuntime,
  signal?: AbortSignal,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Endpoint[]> {
  return await provisionLabStackInDocker(runtime, signal, runner, environment);
}

export async function stackStatus(
  runtime: LabRuntime,
  runner: DockerRunner = defaultDockerRunner,
): Promise<unknown> {
  return await readStackStatus(runtime, runner);
}

export async function stackLogs(
  runtime: LabRuntime,
  service: string,
  tailLines: number,
  runner: DockerRunner = defaultDockerRunner,
): Promise<{ text: string; truncated: boolean }> {
  return await readStackLogs(runtime, service, tailLines, runner);
}

export async function destroyLabStack(
  runtime: LabRuntime,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  await destroyLabStackInDocker(runtime, runner);
}

export async function cleanupLabLabels(
  metadata: LabMetadata,
  removeInternalImage: boolean,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await cleanupLabLabelsInDocker(
    metadata,
    removeInternalImage,
    runner,
    environment,
  );
}

export type DockerRunIdentity = {
  runId: string;
  cwd: string;
  argv: string[];
  environment: Record<string, string>;
};

export function launchDockerRun(
  runtime: LabRuntime,
  invocation: DockerRunIdentity,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): ChildProcessWithoutNullStreams {
  return launchAttachedDockerProcess(runtime, invocation, runner, environment);
}

export async function terminateDockerRun(
  runtime: LabRuntime,
  identity: Pick<DockerRunIdentity, "runId">,
  signal: "INT" | "TERM" | "KILL",
  runner: DockerRunner = defaultDockerRunner,
): Promise<DockerRunTerminationResult> {
  return await terminateAttachedDockerProcess(
    runtime,
    identity,
    signal,
    runner,
  );
}

export function runtimeFromLab(metadata: LabMetadata): LabRuntime {
  return runtimeFromMetadata(metadata);
}
