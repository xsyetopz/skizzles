import {
  hasOnlyKeys,
  isDensePlainArray,
  isPlainDataRecord,
  isSafeRelativePath,
} from "../policy/value.ts";

export type CommandProfile = "read-only" | "build" | "test";
export interface StructuredCommandRequest {
  readonly profile: CommandProfile;
  readonly executable: "git" | "bun";
  readonly arguments: readonly string[];
  readonly cwd: string;
}
export type StructuredCommandResult =
  | Readonly<{ status: "accepted"; command: StructuredCommandRequest }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_COMMAND" | "COMMAND_NOT_ALLOWED";
    }>;

const buildScripts = new Set([
  "build",
  "typecheck",
  "check",
  "packages:build",
  "workspace:check",
  "plugin:check",
]);
const testScripts = new Set(["test"]);
const unsafeToken =
  /(?:^|[\s;&|`$()<>])(?:rm|rmdir|docker|podman|systemctl|launchctl|shutdown|reboot|git\s+(?:clean|reset|checkout))\b|[;&|`$()<>\r\n]/i;

function parseArguments(value: unknown): readonly string[] | null {
  if (!isDensePlainArray(value) || value.length === 0 || value.length > 32)
    return null;
  const args: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 256 ||
      unsafeToken.test(item)
    )
      return null;
    args.push(item);
  }
  return Object.freeze(args);
}

function isReadOnlyGitArguments(args: readonly string[]): boolean {
  const [subcommand, ...options] = args;
  if (subcommand === "status") {
    return (
      options.length === 0 || (options.length === 1 && options[0] === "--short")
    );
  }
  if (subcommand === "diff") {
    return (
      options.length === 0 ||
      (options.length === 1 &&
        ["--stat", "--name-only", "--cached"].includes(options[0] ?? ""))
    );
  }
  if (subcommand === "show") {
    return (
      options.length === 0 || (options.length === 1 && options[0] === "--stat")
    );
  }
  if (subcommand === "log") {
    return (
      options.length === 0 ||
      (options.length === 1 && options[0] === "--oneline")
    );
  }
  if (subcommand === "rev-parse") {
    return (
      options.length === 1 &&
      ["HEAD", "--show-toplevel"].includes(options[0] ?? "")
    );
  }
  return subcommand === "ls-files" && options.length === 0;
}

export function authorizeStructuredCommand(
  input: unknown,
): StructuredCommandResult {
  if (
    !isPlainDataRecord(input) ||
    !hasOnlyKeys(input, ["profile", "executable", "arguments", "cwd"]) ||
    !["read-only", "build", "test"].includes(String(input["profile"])) ||
    (input["executable"] !== "git" && input["executable"] !== "bun") ||
    (input["cwd"] !== "." && !isSafeRelativePath(input["cwd"]))
  )
    return Object.freeze({ status: "rejected", code: "INVALID_COMMAND" });
  const args = parseArguments(input["arguments"]);
  if (args === null)
    return Object.freeze({ status: "rejected", code: "INVALID_COMMAND" });
  let allowed = false;
  if (input["profile"] === "read-only" && input["executable"] === "git")
    allowed = isReadOnlyGitArguments(args);
  if (input["profile"] === "build" && input["executable"] === "bun")
    allowed =
      args[0] === "run" && args.length === 2 && buildScripts.has(args[1] ?? "");
  if (input["profile"] === "test" && input["executable"] === "bun")
    allowed =
      (args[0] === "test" && args.length === 1) ||
      (args[0] === "run" &&
        args.length === 2 &&
        testScripts.has(args[1] ?? ""));
  if (!allowed)
    return Object.freeze({ status: "rejected", code: "COMMAND_NOT_ALLOWED" });
  return Object.freeze({
    status: "accepted",
    command: Object.freeze({
      profile: input["profile"] as CommandProfile,
      executable: input["executable"],
      arguments: args,
      cwd: input["cwd"],
    }),
  });
}
