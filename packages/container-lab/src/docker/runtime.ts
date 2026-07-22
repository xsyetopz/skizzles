import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComposeModel } from "../compose/contract.ts";
import {
  composeCommandArgs,
  emptyComposeEnvironmentFile,
  generateBaseCompose,
  generateOverrideCompose,
} from "../compose/generation.ts";
import {
  inspectComposeModel,
  validateComposeEnvironmentModel,
} from "../compose/inspection.ts";
import { assertComposeInputPolicy, type LabConfig } from "../config.ts";
import type { CommandResult } from "../process/contract.ts";
import { redactPublicText } from "../public/output.ts";
import type { Endpoint, LabMetadata } from "../state/lab/contract.ts";
import type { DockerRunner, LabRuntime } from "./contract.ts";
import {
  composeInvocationEnvironment,
  composeUpEnvironment,
  dockerClientEnvironment,
  isRecord,
  shellQuote,
} from "./environment.ts";
import { immutableComposeArguments } from "./source.ts";

const LOOPBACK_PORT = /^127\.0\.0\.1:(\d+)$/u;
const LEADING_REPLACEMENT_CHARACTER = /^�/u;
const COMPOSE_CONFIGURATION_FAILURE =
  "Docker Compose configuration failed; secret-bearing diagnostics redacted";
const COMPOSE_SOURCE_CHANGED =
  "Docker Compose source changed during inspection; retry lab creation";

type ServiceSummary = {
  service: string;
  state: string;
  health?: string;
  exitCode?: number;
};

export async function dockerAvailableInRuntime(
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  return (
    (
      await runner.run(["info", "--format", "{{.ServerVersion}}"], {
        allowFailure: true,
        timeoutMs: 10_000,
        env: dockerClientEnvironment(environment),
      })
    ).code === 0
  );
}

export async function prepareLabRuntimeInDocker(
  metadata: LabMetadata,
  config: LabConfig,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<LabRuntime & { sourceFile: string }> {
  await assertComposeInputPolicy(config);
  await mkdir(metadata.runtimeRoot, { recursive: true, mode: 0o700 });
  const base = generateBaseCompose(config);
  const generatedBaseFile =
    base === undefined
      ? undefined
      : join(metadata.runtimeRoot, "base.compose.yaml");
  if (generatedBaseFile && base !== undefined) {
    await writeFile(generatedBaseFile, base, { mode: 0o600 });
  }
  const sourceFile = join(metadata.runtimeRoot, "source.compose.json");
  const overrideFile = join(metadata.runtimeRoot, "override.compose.yaml");
  const sourceComposeArgs = composeCommandArgs(config, {
    projectName: metadata.composeProject,
    environmentFile: emptyComposeEnvironmentFile,
    ...(generatedBaseFile === undefined ? {} : { baseFile: generatedBaseFile }),
  });
  const composeEnvironment = composeInvocationEnvironment(
    config.composeEnvironment,
    config.forwardEnvironment,
    environment,
  );
  const sourceDocument = await rawSourceDocument(
    sourceComposeArgs,
    runner,
    composeEnvironment,
  );
  const sourceModel = sourceDocument.model;
  validateComposeEnvironmentModel(
    sourceModel,
    config.composeEnvironment,
    config.secretEnvironment,
    environment,
  );
  const normalizedSourceDocument = await normalizedDocument(
    sourceComposeArgs,
    runner,
    composeEnvironment,
  );
  const confirmedSourceDocument = await rawSourceDocument(
    sourceComposeArgs,
    runner,
    composeEnvironment,
  );
  if (!sourceDocument.bytes.equals(confirmedSourceDocument.bytes)) {
    throw new Error(COMPOSE_SOURCE_CHANGED);
  }
  const normalizedSourceModel = normalizedSourceDocument.model;
  const findings = inspectComposeModel(normalizedSourceModel);
  await writeFile(sourceFile, normalizedSourceDocument.bytes, { mode: 0o600 });
  if (generatedBaseFile !== undefined) {
    await rm(generatedBaseFile);
  }
  const override = generateOverrideCompose(config, normalizedSourceModel, {
    workspaceHostPath: metadata.workspace,
    owner: metadata.owner,
    ownerKey: metadata.ownerKey,
    labId: metadata.id,
  });
  await writeFile(overrideFile, override, { mode: 0o600 });
  const composeArgs = composeCommandArgs(config, {
    projectName: metadata.composeProject,
    overrideFile,
    sourceFiles: [sourceFile],
    environmentFile: emptyComposeEnvironmentFile,
  });
  const finalModel = await normalizedModel(
    composeArgs,
    runner,
    composeEnvironment,
  );
  if (!Object.hasOwn(finalModel.services ?? {}, config.mode.commandService)) {
    throw composeConfigurationFailure();
  }
  return {
    metadata,
    config,
    composeArgs,
    sourceFile,
    overrideFile,
    findings,
  };
}

async function rawSourceDocument(
  composeArgs: string[],
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<{ model: ComposeModel; bytes: Buffer }> {
  return await readComposeDocument(
    [
      ...composeArgs,
      "config",
      "--no-interpolate",
      "--no-normalize",
      "--no-env-resolution",
      "--format",
      "json",
    ],
    runner,
    environment,
  );
}

async function normalizedModel(
  composeArgs: string[],
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<ComposeModel> {
  return (await normalizedDocument(composeArgs, runner, environment)).model;
}

async function normalizedDocument(
  composeArgs: string[],
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<{ model: ComposeModel; bytes: Buffer }> {
  return await readComposeDocument(
    [...composeArgs, "config", "--no-env-resolution", "--format", "json"],
    runner,
    environment,
  );
}

async function readComposeDocument(
  args: string[],
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<{ model: ComposeModel; bytes: Buffer }> {
  let result: CommandResult;
  try {
    result = await runner.run(args, {
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024 * 1024,
      allowFailure: true,
      env: environment,
    });
  } catch {
    throw composeConfigurationFailure();
  }
  if (result.code !== 0) {
    throw composeConfigurationFailure();
  }
  const bytes = Buffer.from(result.stdout);
  const model = parseNormalizedModel(() => JSON.parse(bytes.toString()));
  if (model === undefined) {
    throw composeConfigurationFailure();
  }
  return { model, bytes };
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
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return await runner.run([...immutableComposeArguments(runtime), ...args], {
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.allowFailure === undefined
      ? {}
      : { allowFailure: options.allowFailure }),
    maxOutputBytes: 4 * 1024 * 1024,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    env: composeInvocationEnvironment(
      runtime.config.composeEnvironment,
      runtime.config.forwardEnvironment,
      environment,
    ),
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
      [
        ...immutableComposeArguments(runtime),
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
      ],
      {
        timeoutMs: 30 * 60_000,
        ...(signal === undefined ? {} : { signal }),
        allowFailure: true,
        maxOutputBytes: 4 * 1024 * 1024,
        env: composeUpEnvironment(
          runtime.config.composeEnvironment,
          runtime.config.forwardEnvironment,
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
    environment,
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
      environment,
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
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const result = await runComposeCommand(
    runtime,
    ["ps", "--format", "json"],
    {
      allowFailure: true,
      timeoutMs: 20_000,
    },
    runner,
    environment,
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
  environment: NodeJS.ProcessEnv,
): Promise<{ text: string; truncated: boolean }> {
  if (tailLines < 1 || tailLines > 500) {
    throw new Error("tail-lines must be 1..500");
  }
  const model = await normalizedModel(
    immutableComposeArguments(runtime),
    runner,
    composeInvocationEnvironment(
      runtime.config.composeEnvironment,
      runtime.config.forwardEnvironment,
      environment,
    ),
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
    environment,
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
    return;
  }
  const service =
    stringProperty(value, "Service") ?? stringProperty(value, "Name");
  const state = stringProperty(value, "State");
  if (!(service && state)) {
    return;
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
  const sanitized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isUnsafeControl =
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127;
    return isUnsafeControl ? "�" : character;
  })
    .join("")
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
  return redactPublicText(value.trim(), 2000, 6);
}
