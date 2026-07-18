#!/usr/bin/env bun
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import {
  CliUsageError,
  cliHelpText,
  parseGlobalArguments,
  parseRunArguments,
} from "./cli/arguments.ts";
import { dispatchCliCommand } from "./cli/dispatch.ts";
import { ContainerLabService } from "./lab/orchestrator.ts";
import { serializePublicJson } from "./public/json.ts";
import { redactPublicText } from "./public/output.ts";
import { resolveOwner, resolveRoots } from "./state/layout.ts";
import { CONTAINER_LAB_VERSION } from "./version.ts";

type CliIO = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

const processIO: CliIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export async function cliMain(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  io: CliIO = processIO,
): Promise<number> {
  try {
    const global = parseGlobalArguments(args);
    if (global.help) {
      io.stdout(`${JSON.stringify({ help: cliHelpText() })}\n`);
      return 0;
    }
    if (global.version) {
      io.stdout(`${JSON.stringify({ version: CONTAINER_LAB_VERSION })}\n`);
      return 0;
    }
    const owner = resolveOwner(global.owner, environment);
    const service = new ContainerLabService(
      owner,
      resolveRoots(global),
      undefined,
      environment,
    );
    const controller = new AbortController();
    let signalExit: number | undefined;
    const interrupt = () => {
      signalExit = 130;
      if (!controller.signal.aborted) {
        controller.abort("SIGINT");
      }
    };
    const terminate = () => {
      signalExit = 143;
      if (!controller.signal.aborted) {
        controller.abort("SIGTERM");
      }
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      if (global.rest[0] === "run") {
        return await runAttached(
          service,
          parseRunArguments(global.rest.slice(1)),
          controller.signal,
          io,
        );
      }
      writePublicJson(
        io,
        await dispatchCliCommand(service, global.rest, controller.signal),
      );
      return signalExit ?? 0;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
  } catch (error) {
    const usage = error instanceof CliUsageError;
    io.stderr(
      `${JSON.stringify({
        error: {
          code: usage ? "USAGE" : "OPERATION_FAILED",
          message: boundedError(error),
        },
      })}\n`,
    );
    return usage ? 2 : 1;
  }
}

async function runAttached(
  service: ContainerLabService,
  run: ReturnType<typeof parseRunArguments>,
  signal: AbortSignal,
  io: CliIO,
): Promise<number> {
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const exitCode = await service.run(
    run.lab,
    run.argv,
    run.cwd,
    run.environment,
    run.timeoutSeconds,
    {
      stdout: (chunk) => io.stdout(stdoutDecoder.write(chunk)),
      stderr: (chunk) => io.stderr(stderrDecoder.write(chunk)),
      stdin: process.stdin,
    },
    signal,
  );
  const stdoutTail = stdoutDecoder.end();
  const stderrTail = stderrDecoder.end();
  if (stdoutTail) {
    io.stdout(stdoutTail);
  }
  if (stderrTail) {
    io.stderr(stderrTail);
  }
  return exitCode;
}

function boundedError(error: unknown): string {
  return redactPublicText(
    error instanceof Error ? error.message : String(error),
    4_000,
    8,
  );
}

function writePublicJson(io: CliIO, value: unknown): void {
  io.stdout(serializePublicJson(value));
}

if (import.meta.main) {
  process.exit(await cliMain());
}
