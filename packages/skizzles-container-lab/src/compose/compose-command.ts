import type { CommandResult } from "../execution/process";
import { scrubSecretEnvironment, type DockerRunner, defaultDockerRunner } from "./docker-runner";
import type { LabRuntime } from "./runtime-model";

export async function composeCommand(
  runtime: LabRuntime,
  args: string[],
  options: { timeoutMs?: number; allowFailure?: boolean; signal?: AbortSignal; environment?: NodeJS.ProcessEnv } = {},
  runner: DockerRunner = defaultDockerRunner,
): Promise<CommandResult> {
  return await runner.run([...runtime.composeArgs, ...args], {
    timeoutMs: options.timeoutMs,
    allowFailure: options.allowFailure,
    maxOutputBytes: 4 * 1024 * 1024,
    signal: options.signal,
    env: scrubSecretEnvironment(runtime.config.secretEnvironment, options.environment ?? process.env),
  });
}
