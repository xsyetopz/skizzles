import type { Bucket, Options } from "./types.ts";

const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const localDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const optionsWithValues = new Set([
  "--from",
  "--to",
  "--bucket",
  "--cached-weight",
  "--top",
]);

function parseLocalDate(match: RegExpExecArray, endOfDay: boolean): number {
  const [, year, month, day] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  ).getTime();
}

export function parseDate(value: string, endOfDay = false): number {
  const dateOnly = dateOnlyPattern.exec(value);
  if (dateOnly) return parseLocalDate(dateOnly, endOfDay);
  const local = localDateTimePattern.exec(value);
  if (local) {
    const [, year, month, day, hour, minute, second = "0"] = local;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error(`Invalid date/time: ${value}`);
  return timestamp;
}

export function printHelp(): void {
  console.log(`Usage: bun scripts/analyze.ts --from <date/time> [options]

Analyze Codex rollout usage across active and archived sessions. By default,
the analyzer uses $CODEX_HOME when set, otherwise $HOME/.codex.

Options:
  --from <value>          Inclusive range start (required)
  --to <value>            Inclusive range end (default: now)
  --bucket hour|day       Timeline granularity (default: day)
  --cached-weight <0..1>  Cache-adjusted comparison weight (default: 0.1)
  --top <count>           Maximum rows in ranked tables (default: 10)
  --json                  Emit machine-readable JSON
  -h, --help              Show this help

Local forms like "2026-07-13 07:00" use the machine timezone. A date-only
--to value includes that entire local day. The comparison proxy is not quota
or billing: uncached input + cached input * weight + output.`);
}

type MutableOptions = {
  from?: number;
  to: number;
  bucket: Bucket;
  cachedWeight: number;
  top: number;
  json: boolean;
};

function readValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function applyOption(
  options: MutableOptions,
  argv: readonly string[],
  index: number,
): number {
  const argument = argv[index];
  if (argument === undefined) return index;
  if (argument === "--json") {
    options.json = true;
    return index;
  }
  if (argument === "--help" || argument === "-h") {
    printHelp();
    process.exit(0);
  }
  if (!optionsWithValues.has(argument)) {
    throw new Error(`Unknown argument: ${argument}`);
  }
  const value = readValue(argv, index, argument);
  if (argument === "--from") options.from = parseDate(value);
  else if (argument === "--to") options.to = parseDate(value, true);
  else if (argument === "--bucket") {
    if (value !== "hour" && value !== "day") {
      throw new Error("--bucket must be hour or day");
    }
    options.bucket = value;
  } else if (argument === "--cached-weight") {
    options.cachedWeight = Number(value);
  } else if (argument === "--top") options.top = Number(value);
  return index + 1;
}

function validateOptions(options: MutableOptions): asserts options is Options {
  if (options.from === undefined) throw new Error("--from is required");
  if (
    !Number.isFinite(options.cachedWeight) ||
    options.cachedWeight < 0 ||
    options.cachedWeight > 1
  ) {
    throw new Error("--cached-weight must be between 0 and 1");
  }
  if (!Number.isInteger(options.top) || options.top < 1) {
    throw new Error("--top must be a positive integer");
  }
  if (options.from > options.to) {
    throw new Error("--from must not be after --to");
  }
}

export function parseArgs(argv: readonly string[]): Options {
  const options: MutableOptions = {
    to: Date.now(),
    bucket: "day",
    cachedWeight: 0.1,
    top: 10,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    index = applyOption(options, argv, index);
  }
  validateOptions(options);
  return options;
}
