import { isAbsolute } from "node:path";
import { runCommand } from "../process.ts";
import type { CommandResult, RunOptions } from "./contract.ts";

type GitRunOptions = Omit<RunOptions, "env">;

const isolatedGitConfiguration = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.logAllRefUpdates=false",
] as const;

/** Run local Git without ambient or repository-local executable configuration. */
export async function runLocalGit(
  args: readonly string[],
  options: GitRunOptions,
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  assertLocalClone(args);
  return await runCommand("git", [...isolatedGitConfiguration, ...args], {
    ...options,
    env: gitProcessEnvironment(environment),
  });
}

function assertLocalClone(args: readonly string[]): void {
  if (args[0] !== "clone") {
    return;
  }
  const source = args.at(-2);
  const destination = args.at(-1);
  if (
    !args.includes("--local") ||
    typeof source !== "string" ||
    typeof destination !== "string" ||
    !isAbsolute(source) ||
    !isAbsolute(destination)
  ) {
    throw new Error("Git clone requires absolute local source and destination");
  }
}

export function gitProcessEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP"] as const) {
    const value = environment[name];
    if (Object.hasOwn(environment, name) && typeof value === "string") {
      result[name] = value;
    }
  }
  return result;
}
