export class CliUsageError extends Error {}

const INTEGER = /^[0-9]+$/;

export type GlobalArguments = {
  owner?: string;
  stateRoot?: string;
  runtimeRoot?: string;
  help: boolean;
  version: boolean;
  rest: string[];
};

export function parseGlobalArguments(args: string[]): GlobalArguments {
  const parsed: GlobalArguments = {
    help: false,
    version: false,
    rest: [],
  };
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-V") {
      parsed.version = true;
    } else if (arg === "--owner") {
      parsed.owner = requiredValue(args, ++index, arg);
    } else if (arg === "--state-root") {
      parsed.stateRoot = requiredValue(args, ++index, arg);
    } else if (arg === "--runtime-root") {
      parsed.runtimeRoot = requiredValue(args, ++index, arg);
    } else {
      break;
    }
  }
  parsed.rest = args.slice(index);
  return parsed;
}

export function parseCommandFlags(
  args: string[],
  allowed: Set<string>,
  repeatable = new Set<string>(),
) {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index] ?? "";
    if (!allowed.has(flag)) {
      throw new CliUsageError(`unknown argument: ${flag}`);
    }
    const value = requiredValue(args, ++index, flag);
    const existing = values.get(flag) ?? [];
    if (existing.length > 0 && !repeatable.has(flag)) {
      throw new CliUsageError(`${flag} may be provided only once`);
    }
    existing.push(value);
    values.set(flag, existing);
  }
  return {
    one: (flag: string) => values.get(flag)?.[0],
    many: (flag: string) => values.get(flag) ?? [],
    required: (flag: string) => {
      const value = values.get(flag)?.[0];
      if (value === undefined) {
        throw new CliUsageError(`${flag} is required`);
      }
      return value;
    },
  };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
}

export function requireNoArguments(args: string[]): void {
  if (args.length > 0) {
    throw new CliUsageError(`unexpected argument: ${args[0]}`);
  }
}

function parseEnvironment(value: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 1) {
    throw new CliUsageError("--env must be KEY=VALUE");
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

export function parseRunArguments(args: string[]): {
  lab: string;
  cwd: string;
  environment: Record<string, string>;
  timeoutSeconds: number;
  argv: string[];
} {
  const separator = args.indexOf("--");
  if (separator < 0) {
    throw new CliUsageError("run requires -- before the command argv");
  }
  const flags = parseCommandFlags(
    args.slice(0, separator),
    new Set(["--lab", "--cwd", "--env", "--timeout-seconds"]),
    new Set(["--env"]),
  );
  const argv = args.slice(separator + 1);
  if (argv.length === 0) {
    throw new CliUsageError("run requires a command after --");
  }
  return {
    lab: flags.required("--lab"),
    cwd: flags.one("--cwd") ?? ".",
    environment: Object.fromEntries(flags.many("--env").map(parseEnvironment)),
    timeoutSeconds: integerFlag(
      flags.one("--timeout-seconds"),
      "--timeout-seconds",
      1800,
    ),
    argv,
  };
}

export function integerFlag(
  value: string | undefined,
  flag: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!INTEGER.test(value)) {
    throw new CliUsageError(`${flag} must be an integer`);
  }
  return Number(value);
}

export function syncDirection(value: string): "push" | "pull" {
  if (value !== "push" && value !== "pull") {
    throw new CliUsageError("--direction must be push or pull");
  }
  return value;
}

export function cliHelpText(): string {
  return [
    "codex-container-lab [--owner THREAD_ID] [--state-root PATH] [--runtime-root PATH] COMMAND",
    "health",
    "lab create [--name NAME] [--source PATH]",
    "lab list | lab status --lab ID | lab destroy --lab ID | lab destroy-all",
    "run --lab ID [--cwd PATH] [--env KEY=VALUE] [--timeout-seconds N] -- COMMAND...",
    "logs --lab ID --service SERVICE [--tail-lines N]",
    "sync preview --lab ID --direction push|pull",
    "sync apply --lab ID --direction push|pull --token TOKEN",
  ].join("\n");
}
