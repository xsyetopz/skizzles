import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  type CatalogRefreshOptions,
  type CatalogRefreshResult,
  refreshCatalog,
  resolveCatalogPaths,
} from "./catalog/refresh.ts";
import {
  prepareCatalogStorePaths,
  validateCatalogStorePaths,
  validatePhysicalDirectory,
  validatePhysicalRegularFile,
  writePrivateAtomic,
} from "./catalog/store.ts";
import { CodexChildError } from "./codex/child.ts";
import { renderLaunchAgent } from "./launch-agent.ts";

const USAGE =
  "usage: skizzles-model-catalog <refresh|service|render-launch-agent> [options]";

type ValueFlag =
  | "--bun"
  | "--cache"
  | "--codex-binary"
  | "--codex-home"
  | "--output"
  | "--script"
  | "--status"
  | "--template";

interface ParsedOptions {
  values: Partial<Record<ValueFlag, string>>;
  switches: Set<string>;
}

function recordSwitch(found: Set<string>, flag: string): void {
  if (found.has(flag)) {
    throw new Error(`${flag} must not be repeated`);
  }
  found.add(flag);
}

function recordValue(
  args: string[],
  index: number,
  allowed: ReadonlySet<ValueFlag>,
  values: Partial<Record<ValueFlag, string>>,
): number {
  const token = args[index];
  if (token === undefined) {
    return index;
  }
  if (!isValueFlag(token, allowed)) {
    throw new Error(
      token.startsWith("--")
        ? `unknown option ${token}`
        : `unexpected argument ${token}`,
    );
  }
  const flag = token;
  if (values[flag] !== undefined) {
    throw new Error(`${flag} must not be repeated`);
  }
  const found = args[index + 1];
  if (found === undefined || found.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  if (found.length === 0 || !isAbsolute(found)) {
    throw new Error(`${flag} requires a nonempty absolute path`);
  }
  values[flag] = found;
  return index + 1;
}

function isValueFlag(
  value: string,
  allowed: ReadonlySet<ValueFlag>,
): value is ValueFlag {
  for (const flag of allowed) {
    if (flag === value) {
      return true;
    }
  }
  return false;
}

function parseOptions(
  args: string[],
  valueFlags: readonly ValueFlag[],
  switches: readonly string[] = [],
): ParsedOptions {
  const allowedValues = new Set<ValueFlag>(valueFlags);
  const allowedSwitches = new Set(switches);
  const values: Partial<Record<ValueFlag, string>> = {};
  const foundSwitches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      break;
    }
    if (allowedSwitches.has(token)) {
      recordSwitch(foundSwitches, token);
      continue;
    }
    index = recordValue(args, index, allowedValues, values);
  }
  return { values, switches: foundSwitches };
}

function required(options: ParsedOptions, flag: ValueFlag): string {
  const found = options.values[flag];
  if (found === undefined) {
    throw new Error(`${flag} is required`);
  }
  return found;
}

function refreshOptions(parsed: ParsedOptions): CatalogRefreshOptions {
  const output = parsed.values["--output"];
  const status = parsed.values["--status"];
  const cache = parsed.values["--cache"];
  return {
    codexHome: required(parsed, "--codex-home"),
    codexBinary: required(parsed, "--codex-binary"),
    ...(output === undefined ? {} : { output }),
    ...(status === undefined ? {} : { status }),
    ...(cache === undefined ? {} : { cache }),
  };
}

async function runRefresh(args: string[], service: boolean): Promise<void> {
  const parsed = parseOptions(
    args,
    ["--codex-home", "--codex-binary", "--status", "--output", "--cache"],
    service ? [] : ["--quiet-unchanged"],
  );
  const options = refreshOptions(parsed);
  const paths = resolveCatalogPaths(options);
  await prepareCatalogStorePaths(paths);
  const { status } = paths;
  let result: CatalogRefreshResult;
  try {
    result = await refreshCatalog({ ...options, status });
  } catch (error) {
    if (service) {
      const message =
        error instanceof CodexChildError
          ? `model catalog child failure: ${error.message}`
          : "model catalog refresh failed";
      await writePrivateAtomic(
        status,
        `${JSON.stringify(
          { ok: false, error: message, checkedAt: new Date().toISOString() },
          null,
          2,
        )}\n`,
        { beforePromote: async () => validateCatalogStorePaths(paths) },
      );
    }
    throw error;
  }
  if (
    !service &&
    (result.updated || !parsed.switches.has("--quiet-unchanged"))
  ) {
    console.log(JSON.stringify(result));
  }
}

async function runRenderLaunchAgent(args: string[]): Promise<void> {
  const parsed = parseOptions(args, [
    "--template",
    "--output",
    "--bun",
    "--script",
    "--codex-home",
    "--codex-binary",
  ]);
  const output = required(parsed, "--output");
  const template = required(parsed, "--template");
  const bun = required(parsed, "--bun");
  const script = required(parsed, "--script");
  const codexHome = required(parsed, "--codex-home");
  const codexBinary = required(parsed, "--codex-binary");
  await Promise.all([
    validatePhysicalRegularFile(template),
    validatePhysicalRegularFile(bun),
    validatePhysicalRegularFile(script),
    validatePhysicalDirectory(codexHome),
    validatePhysicalRegularFile(codexBinary),
  ]);
  const rendered = renderLaunchAgent(await readFile(template, "utf8"), {
    bun,
    script,
    codexHome,
    codexBinary,
  });
  await writePrivateAtomic(output, rendered);
  console.log(JSON.stringify({ ok: true, output: resolve(output) }));
}

export function runModelCatalogCli(args: string[]): Promise<void> {
  const [command, ...options] = args;
  if (command === "refresh") {
    return runRefresh(options, false);
  }
  if (command === "service") {
    return runRefresh(options, true);
  }
  if (command === "render-launch-agent") {
    return runRenderLaunchAgent(options);
  }
  throw new Error(USAGE);
}
