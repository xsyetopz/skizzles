import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { LabConfig } from "./config.ts";
import {
  launchAttachedDockerProcess,
  terminateAttachedDockerProcess,
} from "./docker/attached-process.ts";
import {
  cleanupLabLabelsInDocker,
  destroyLabStackInDocker,
} from "./docker/cleanup.ts";
import type {
  BoundLabRuntime,
  DockerRunIdentity,
  DockerRunner,
  DockerRunTerminationResult,
  LabRuntime,
} from "./docker/contract.ts";
import {
  dockerAvailableInRuntime,
  prepareLabRuntimeInDocker,
  provisionLabStackInDocker,
  readStackLogs,
  readStackStatus,
  runComposeCommand,
  runtimeFromMetadata,
} from "./docker/runtime.ts";
import { type CommandResult, runCommand } from "./process.ts";
import type { Endpoint, LabMetadata } from "./state/lab/contract.ts";

export const defaultDockerRunner: DockerRunner = {
  run: async (args, options) => await runCommand("docker", args, options),
  spawn: (args, options) =>
    spawn("docker", args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    }),
};

export async function dockerAvailable(
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): Promise<boolean> {
  return await dockerAvailableInRuntime(runner, environment);
}

export async function prepareLabRuntime(
  metadata: LabMetadata,
  config: LabConfig,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): Promise<BoundLabRuntime> {
  return await prepareLabRuntimeInDocker(metadata, config, runner, environment);
}

export async function composeCommand(
  runtime: LabRuntime,
  args: string[],
  options: {
    timeoutMs?: number;
    allowFailure?: boolean;
    signal?: AbortSignal;
  },
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return await runComposeCommand(runtime, args, options, runner, environment);
}

export async function provisionLabStack(
  runtime: LabRuntime,
  signal: AbortSignal | undefined,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): Promise<Endpoint[]> {
  return await provisionLabStackInDocker(runtime, signal, runner, environment);
}

export async function stackStatus(
  runtime: LabRuntime,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): Promise<unknown> {
  return await readStackStatus(runtime, runner, environment);
}

export async function stackLogs(
  runtime: LabRuntime,
  service: string,
  tailLines: number,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): Promise<{ text: string; truncated: boolean }> {
  return await readStackLogs(runtime, service, tailLines, runner, environment);
}

export async function destroyLabStack(
  runtime: LabRuntime,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): Promise<void> {
  await destroyLabStackInDocker(runtime, runner, environment);
}

export async function cleanupLabLabels(
  metadata: LabMetadata,
  removeInternalImage: boolean,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): Promise<void> {
  await cleanupLabLabelsInDocker(
    metadata,
    removeInternalImage,
    runner,
    environment,
  );
}

export function launchDockerRun(
  runtime: LabRuntime,
  invocation: DockerRunIdentity,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  return launchAttachedDockerProcess(runtime, invocation, runner, environment);
}

export async function terminateDockerRun(
  runtime: LabRuntime,
  identity: Pick<DockerRunIdentity, "runId">,
  signal: "INT" | "TERM" | "KILL",
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = {},
): Promise<DockerRunTerminationResult> {
  return await terminateAttachedDockerProcess(
    runtime,
    identity,
    signal,
    runner,
    environment,
  );
}

export function runtimeFromLab(metadata: LabMetadata): LabRuntime {
  return runtimeFromMetadata(metadata);
}

export type {
  BoundLabRuntime,
  DockerRunIdentity,
  DockerRunner,
  DockerRunOptions,
  DockerRunTerminationResult,
  DockerSpawnOptions,
  LabRuntime,
} from "./docker/contract.ts";
