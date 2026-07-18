import { runCommand } from "./run-command.ts";
import { RunStoreQueries } from "./run-queries.ts";
import { runRoot } from "./settings.ts";
import type { StreamName } from "./types.ts";

const usage =
  "usage: codex-command run --base64url <script> | status <run-id> | tail <run-id> [stdout|stderr] | errors <run-id> | search <text> [run-id]";
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

function decodeScript(value: string): string {
  if (!base64UrlPattern.test(value)) {
    throw new Error("encoded script is not base64url");
  }
  const result = Buffer.from(value, "base64url").toString("utf8");
  if (!result || Buffer.from(result, "utf8").toString("base64url") !== value) {
    throw new Error("encoded script is invalid");
  }
  return result;
}

function selectedStream(value: string | undefined): StreamName {
  const stream = value ?? "stdout";
  if (stream !== "stdout" && stream !== "stderr") {
    throw new Error("stream must be stdout or stderr");
  }
  return stream;
}

function writeTail(content: string): void {
  process.stdout.write(content);
  if (!content.endsWith("\n")) process.stdout.write("\n");
}

function requiredArgument(arguments_: string[], index: number): string {
  const value = arguments_[index];
  if (value === undefined) throw new Error("missing command argument");
  return value;
}

function executeRun(arguments_: string[]): Promise<number> | undefined {
  if (arguments_.length !== 2 || arguments_[0] !== "--base64url") {
    return undefined;
  }
  return runCommand(decodeScript(requiredArgument(arguments_, 1)));
}

function executeQuery(
  subcommand: string | undefined,
  arguments_: string[],
): number | undefined {
  const queries = new RunStoreQueries(runRoot());
  if (subcommand === "status" && arguments_.length === 1) {
    process.stdout.write(queries.status(requiredArgument(arguments_, 0)));
    return 0;
  }
  if (
    subcommand === "tail" &&
    (arguments_.length === 1 || arguments_.length === 2)
  ) {
    writeTail(
      queries.tail(
        requiredArgument(arguments_, 0),
        selectedStream(arguments_[1]),
      ),
    );
    return 0;
  }
  if (subcommand === "errors" && arguments_.length === 1) {
    writeTail(queries.tail(requiredArgument(arguments_, 0), "stderr"));
    return 0;
  }
  if (
    subcommand === "search" &&
    (arguments_.length === 1 || arguments_.length === 2)
  ) {
    for (const path of queries.search(
      requiredArgument(arguments_, 0),
      arguments_[1],
    )) {
      console.log(path);
    }
    return 0;
  }
  return undefined;
}

function execute(
  subcommand: string | undefined,
  arguments_: string[],
): number | Promise<number> | undefined {
  return subcommand === "run"
    ? executeRun(arguments_)
    : executeQuery(subcommand, arguments_);
}

export async function dispatchCommand(arguments_: string[]): Promise<number> {
  const [subcommand, ...subcommandArguments] = arguments_;
  try {
    const exitCode = await execute(subcommand, subcommandArguments);
    if (exitCode !== undefined) return exitCode;
    console.error(usage);
    return 64;
  } catch (error) {
    console.error(
      `[codex-command] ${
        error instanceof Error ? error.message : "unexpected failure"
      }`,
    );
    return 64;
  }
}
