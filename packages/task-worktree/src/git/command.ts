import { dirname } from "node:path";
import {
  observeCommand,
  recoverCommandOutput,
} from "@skizzles/command-supervisor";

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandAuthority {
  readonly executable: string;
  readonly run: (
    cwd: string,
    arguments_: readonly string[],
    allowedExitCodes?: readonly number[],
  ) => Promise<GitCommandResult | undefined>;
}

export function createGitCommandAuthority(): GitCommandAuthority | undefined {
  const executable = Bun.which("git");
  if (executable === null) return;
  const run = async (
    cwd: string,
    arguments_: readonly string[],
    allowedExitCodes: readonly number[] = [0],
  ): Promise<GitCommandResult | undefined> => {
    const receipt = await observeCommand({
      version: 1,
      argv: Object.freeze([
        executable,
        "-c",
        "core.hooksPath=/dev/null",
        ...arguments_,
      ]),
      cwd,
      env: Object.freeze({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: dirname(executable),
        LC_ALL: "C",
        PATH: dirname(executable),
      }),
      timeoutMilliseconds: 30_000,
      maximumOutputBytes: 4 * 1024 * 1024,
      drainMilliseconds: 1000,
      signalGraceMilliseconds: 1000,
    });
    if (
      receipt.outcome.kind !== "exited" ||
      receipt.outcome.exitCode === null ||
      !allowedExitCodes.includes(receipt.outcome.exitCode) ||
      receipt.outcome.signal !== null ||
      receipt.outcome.failureCode !== null ||
      receipt.outcome.outputLimitStream !== null ||
      receipt.lifecycle.drain !== "complete" ||
      receipt.lifecycle.cleanup === "killed" ||
      receipt.stdout.truncated ||
      receipt.stderr.truncated ||
      receipt.stdout.observedBytes !== receipt.stdout.retainedBytes ||
      receipt.stderr.observedBytes !== receipt.stderr.retainedBytes
    ) {
      return;
    }
    try {
      return Object.freeze({
        exitCode: receipt.outcome.exitCode,
        stdout: new TextDecoder("utf-8", { fatal: true }).decode(
          recoverCommandOutput(receipt, "stdout"),
        ),
        stderr: new TextDecoder("utf-8", { fatal: true }).decode(
          recoverCommandOutput(receipt, "stderr"),
        ),
      });
    } catch {
      return undefined;
    }
  };
  return Object.freeze({ executable, run });
}
