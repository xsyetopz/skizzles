import process from "node:process";
import { executeCommand } from "./process/execution.ts";
import { assertProcessPlatform } from "./process/platform.ts";

interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowFailure?: boolean;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  assertProcessPlatform(process.platform, command);
  if (options.signal?.aborted) {
    throw new Error(`${command} aborted`);
  }
  return await executeCommand(command, args, options);
}

export type { CommandResult, RunOptions };
export { runCommand };
