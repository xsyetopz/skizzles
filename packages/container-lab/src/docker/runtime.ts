import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not follow yaml's package exports; yaml is a declared runtime dependency.
import { parse as parseYaml } from "yaml";
import type { ComposeModel } from "../compose/contract.ts";
import {
  composeCommandArgs,
  generateBaseCompose,
  generateOverrideCompose,
} from "../compose/generation.ts";
import {
  inspectComposeModel,
  validateSecretEnvironmentModel,
} from "../compose/inspection.ts";
import type { LabConfig } from "../config.ts";
import type { DockerRunner, LabRuntime } from "../docker.ts";
import type { CommandResult } from "../process.ts";
import { redactPublicText } from "../public/output.ts";
import type { Endpoint, LabMetadata } from "../state/lab/contract.ts";
import {
  isRecord,
  scrubSecretEnvironment,
  secretComposeEnvironment,
  shellQuote,
} from "./environment.ts";

const LOOPBACK_PORT = /^127\.0\.0\.1:(\d+)$/;
const LEADING_REPLACEMENT_CHARACTER = /^�/;
const COMPOSE_CONFIGURATION_FAILURE =
  "Docker Compose configuration failed; secret-bearing diagnostics redacted";

type ServiceSummary = {
  service: string;
  state: string;
  health?: string;
  exitCode?: number;
};

export async function dockerAvailableInRuntime(
  runner: DockerRunner,
  secretEnvironment: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  return (
    (
      await runner.run(["info", "--format", "{{.ServerVersion}}"], {
        allowFailure: true,
        timeoutMs: 10_000,
        env: scrubSecretEnvironment(secretEnvironment, environment),
      })
    ).code === 0
  );
}

export async function prepareLabRuntimeInDocker(
  metadata: LabMetadata,
  config: LabConfig,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<LabRuntime> {
  await mkdir(metadata.runtimeRoot, { recursive: true, mode: 0o700 });
  const base = generateBaseCompose(config);
  const baseFile =
    base === undefined
      ? undefined
      : join(metadata.runtimeRoot, "base.compose.yaml");
  if (baseFile && base !== undefined) {
    await writeFile(baseFile, base, { mode: 0o600 });
  }
  const overrideFile = join(metadata.runtimeRoot, "override.compose.yaml");
  await writeFile(overrideFile, "{}\n", { mode: 0o600 });
  const composeArgs = composeCommandArgs(config, {
    projectName: metadata.composeProject,
    overrideFile,
    ...(baseFile === undefined ? {} : { baseFile }),
  });
  const composeEnvironment = secretComposeEnvironment(
    config.secretEnvironment,
    environment,
  );
  const sourceModel = await normalizedModel(
    composeArgs,
    runner,
    composeEnvironment,
  );
  validateSecretEnvironmentModel(
    sourceModel,
    config.secretEnvironment,
    composeEnvironment,
  );
  const findings = inspectComposeModel(sourceModel);
  const override = generateOverrideCompose(config, sourceModel, {
    workspaceHostPath: metadata.workspace,
    owner: metadata.owner,
    ownerKey: metadata.ownerKey,
    labId: metadata.id,
  });
  await writeFile(overrideFile, override, { mode: 0o600 });
  const finalModel = await normalizedModel(
    composeArgs,
    runner,
    composeEnvironment,
  );
  validateSecretEnvironmentModel(
    finalModel,
    config.secretEnvironment,
    composeEnvironment,
  );
  return {
    metadata,
    config,
    composeArgs,
    ...(baseFile === undefined ? {} : { baseFile }),
    overrideFile,
    findings,
  };
}

async function normalizedModel(
  composeArgs: string[],
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<ComposeModel> {
  let result: CommandResult;
  try {
    result = await runner.run(
      [...composeArgs, "config", "--no-interpolate", "--format", "json"],
      {
        timeoutMs: 30_000,
        maxOutputBytes: 16 * 1024 * 1024,
        allowFailure: true,
        env: environment,
      },
    );
  } catch {
    throw composeConfigurationFailure();
  }
  if (result.code === 0) {
    const jsonModel = parseNormalizedModel(() =>
      JSON.parse(result.stdout.toString()),
    );
    if (jsonModel !== undefined) {
      return jsonModel;
    }
  }
  let yaml: CommandResult;
  try {
    yaml = await runner.run([...composeArgs, "config", "--no-interpolate"], {
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024 * 1024,
      allowFailure: true,
      env: environment,
    });
  } catch {
    throw composeConfigurationFailure();
  }
  if (yaml.code !== 0) {
    throw composeConfigurationFailure();
  }
  const yamlModel = parseNormalizedModel(() =>
    parseYaml(yaml.stdout.toString()),
  );
  if (yamlModel === undefined) {
    throw composeConfigurationFailure();
  }
  return yamlModel;
}

function parseNormalizedModel(parse: () => unknown): ComposeModel | undefined {
  try {
    const value = parse();
    return isComposeModel(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isComposeModel(value: unknown): value is ComposeModel {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isOptionalRecordOf(value["services"], isRecord) &&
    isOptionalRecordOf(value["volumes"], isNullableRecord) &&
    isOptionalRecordOf(value["networks"], isNullableRecord) &&
    isOptionalRecord(value["secrets"]) &&
    isOptionalRecord(value["configs"])
  );
}

function isOptionalRecordOf(
  value: unknown,
  isValue: (candidate: unknown) => boolean,
): boolean {
  if (value === undefined) {
    return true;
  }
  return isRecord(value) && Object.values(value).every(isValue);
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isNullableRecord(value: unknown): boolean {
  return value === null || isRecord(value);
}

function composeConfigurationFailure(): Error {
  return new Error(COMPOSE_CONFIGURATION_FAILURE);
}

export async function runComposeCommand(
  runtime: LabRuntime,
  args: string[],
  options: {
    timeoutMs?: number;
    allowFailure?: boolean;
    signal?: AbortSignal;
  },
  runner: DockerRunner,
): Promise<CommandResult> {
  return await runner.run([...runtime.composeArgs, ...args], {
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.allowFailure === undefined
      ? {}
      : { allowFailure: options.allowFailure }),
    maxOutputBytes: 4 * 1024 * 1024,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    env: scrubSecretEnvironment(runtime.config.secretEnvironment, process.env),
  });
}

export async function provisionLabStackInDocker(
  runtime: LabRuntime,
  signal: AbortSignal | undefined,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<Endpoint[]> {
  let provisioned: CommandResult;
  try {
    provisioned = await runner.run(
      [...runtime.composeArgs, "up", "-d", "--wait", "--wait-timeout", "180"],
      {
        timeoutMs: 30 * 60_000,
        ...(signal === undefined ? {} : { signal }),
        allowFailure: true,
        maxOutputBytes: 4 * 1024 * 1024,
        env: secretComposeEnvironment(
          runtime.config.secretEnvironment,
          environment,
        ),
      },
    );
  } catch {
    throw new Error(
      signal?.aborted
        ? "Docker Compose up aborted; secret-bearing diagnostics redacted"
        : "Docker Compose up failed; secret-bearing diagnostics redacted",
    );
  }
  if (provisioned.code !== 0) {
    throw new Error(
      "Docker Compose up failed; secret-bearing diagnostics redacted",
    );
  }
  const compatibility = [
    `test -d ${shellQuote(runtime.config.runtime.workspace)}`,
    `test -w ${shellQuote(runtime.config.runtime.workspace)}`,
    "command -v setsid >/dev/null 2>&1",
  ].join(" && ");
  const verified = await runComposeCommand(
    runtime,
    [
      "exec",
      "-T",
      runtime.config.mode.commandService,
      ...runtime.config.runtime.shell,
      compatibility,
    ],
    {
      allowFailure: true,
      timeoutMs: 20_000,
      ...(signal === undefined ? {} : { signal }),
    },
    runner,
  );
  if (verified.code !== 0) {
    throw new Error(
      "command service compatibility check failed: configured shell, writable workspace, and setsid are required",
    );
  }
  const endpoints: Endpoint[] = [];
  for (const port of runtime.config.ports) {
    const result = await runComposeCommand(
      runtime,
      ["port", port.service, String(port.target)],
      { timeoutMs: 20_000 },
      runner,
    );
    const loopback = result.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => line.trim().match(LOOPBACK_PORT)?.[1])
      .filter((value): value is string => value !== undefined);
    if (loopback.length !== 1) {
      throw new Error(
        `unable to uniquely resolve declared loopback port ${port.name}`,
      );
    }
    const loopbackPort = loopback[0];
    if (loopbackPort === undefined) {
      throw new Error(
        `unable to uniquely resolve declared loopback port ${port.name}`,
      );
    }
    endpoints.push({
      name: port.name,
      service: port.service,
      target: port.target,
      url: `${port.scheme ?? "tcp"}://127.0.0.1:${loopbackPort}`,
    });
  }
  return endpoints;
}

export async function readStackStatus(
  runtime: LabRuntime,
  runner: DockerRunner,
): Promise<unknown> {
  const result = await runComposeCommand(
    runtime,
    ["ps", "--format", "json"],
    {
      allowFailure: true,
      timeoutMs: 20_000,
    },
    runner,
  );
  if (result.code !== 0) {
    return { available: false, error: compactError(result.stderr.toString()) };
  }
  const raw = result.stdout.toString().trim();
  if (!raw) {
    return { available: true, services: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return {
      available: true,
      services: summarizeServices(Array.isArray(parsed) ? parsed : [parsed]),
    };
  } catch {
    try {
      return {
        available: true,
        services: summarizeServices(
          raw
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as unknown),
        ),
      };
    } catch {
      return {
        available: false,
        error: "Docker returned an invalid bounded status response",
      };
    }
  }
}

export async function readStackLogs(
  runtime: LabRuntime,
  service: string,
  tailLines: number,
  runner: DockerRunner,
): Promise<{ text: string; truncated: boolean }> {
  if (tailLines < 1 || tailLines > 500) {
    throw new Error("tail-lines must be 1..500");
  }
  const model = await normalizedModel(
    runtime.composeArgs,
    runner,
    scrubSecretEnvironment(runtime.config.secretEnvironment, process.env),
  );
  if (!Object.hasOwn(model.services ?? {}, service)) {
    throw new Error(`unknown Compose service: ${service}`);
  }
  const result = await runComposeCommand(
    runtime,
    ["logs", "--no-color", "--tail", String(tailLines), service],
    {
      allowFailure: true,
      timeoutMs: 20_000,
    },
    runner,
  );
  return boundedLogTail(
    `${result.stdout}${result.stderr}`,
    tailLines,
    8 * 1024,
  );
}

export function runtimeFromMetadata(metadata: LabMetadata): LabRuntime {
  if (!metadata.runtime) {
    throw new Error(`lab runtime is unavailable: ${metadata.id}`);
  }
  return { metadata, ...metadata.runtime };
}

function summarizeServices(values: unknown[]): ServiceSummary[] {
  return values
    .slice(0, 16)
    .map(summarizeService)
    .filter((value): value is ServiceSummary => value !== undefined);
}

function summarizeService(value: unknown): ServiceSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const service =
    stringProperty(value, "Service") ?? stringProperty(value, "Name");
  const state = stringProperty(value, "State");
  if (!(service && state)) {
    return undefined;
  }
  const summary: ServiceSummary = {
    service: service.slice(0, 128),
    state: state.slice(0, 64),
  };
  const health = stringProperty(value, "Health");
  if (health) {
    summary.health = health.slice(0, 64);
  }
  const exitCode = numericProperty(value, "ExitCode");
  if (Number.isInteger(exitCode)) {
    summary.exitCode = exitCode;
  }
  return summary;
}

function stringProperty(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function numericProperty(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  return typeof candidate === "number" ? candidate : Number(candidate);
}

function boundedLogTail(
  value: string,
  maxLines: number,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const sanitized = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips unsafe terminal control bytes while retaining tabs and line breaks.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
    .trimEnd();
  const lines = sanitized.split("\n");
  let selected = lines.slice(-maxLines).join("\n");
  let truncated = lines.length > maxLines;
  let bytes = Buffer.from(selected);
  if (bytes.byteLength > maxBytes) {
    bytes = bytes.subarray(bytes.byteLength - maxBytes);
    selected = bytes
      .toString("utf8")
      .replace(LEADING_REPLACEMENT_CHARACTER, "");
    truncated = true;
  }
  return { text: selected, truncated };
}

function compactError(value: string): string {
  return redactPublicText(value.trim(), 2_000, 6);
}
