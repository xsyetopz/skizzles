import process from "node:process";
import type {
  CommandResult as CommandResultContract,
  RunOptions as RunOptionsContract,
} from "./process/contract.ts";
import { executeCommand } from "./process/execution.ts";
import { assertProcessPlatform } from "./process/platform.ts";

async function runCommand(
  command: string,
  args: string[],
  options: RunOptionsContract = {},
): Promise<CommandResultContract> {
  assertProcessPlatform(process.platform, command);
  if (options.signal?.aborted) {
    throw new Error(`${command} aborted`);
  }
  return await executeCommand(command, args, options);
}

export type { CommandResult, RunOptions } from "./process/contract.ts";
export { runCommand };
