import type { CommandResult } from "../execution/process";
import { redactPublicText } from "../public/output";
import { defaultDockerRunner, scrubSecretEnvironment, type DockerRunner } from "./docker-runner";
import { composeCommand } from "./compose-command";
import { normalizedComposeModel } from "./compose-model";
import type { LabRuntime } from "./runtime-model";

export type ServiceSummary = {
  service: string;
  state: string;
  health?: string;
  exitCode?: number;
};

type StackServiceStatus = {
  available: boolean;
  services: ServiceSummary[];
  serviceCount: number;
  error?: string;
};

export async function stackStatus(
  runtime: LabRuntime,
  runner: DockerRunner = defaultDockerRunner,
  options: { all?: boolean; environment?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  const status = await listStackServiceSummaries(runtime, runner, options.environment, options.all === true);
  if (!status.available) return { available: false, error: status.error };
  return {
    available: true,
    ...(options.all ? { serviceCount: status.serviceCount } : {}),
    services: status.services.slice(0, 16),
  };
}

export async function listStackServiceSummaries(
  runtime: LabRuntime,
  runner: DockerRunner,
  environment?: NodeJS.ProcessEnv,
  all = true,
): Promise<StackServiceStatus> {
  let result: CommandResult;
  try {
    result = await composeCommand(runtime, ["ps", ...(all ? ["--all"] : []), "--format", "json"], {
      allowFailure: true,
      timeoutMs: 20_000,
      environment,
    }, runner);
  } catch {
    return { available: false, services: [], serviceCount: 0, error: "Docker returned an unavailable status response" };
  }
  if (result.code !== 0) {
    return { available: false, services: [], serviceCount: 0, error: compactError(result.stderr.toString()) };
  }
  const raw = result.stdout.toString().trim();
  if (!raw) return { available: true, services: [], serviceCount: 0 };
  const values = parseStatusValues(raw, 1_000);
  if (!values) {
    return { available: false, services: [], serviceCount: 0, error: "Docker returned an invalid bounded status response" };
  }
  return {
    available: true,
    services: summarizeServices(values, 1_000),
    serviceCount: values.length,
  };
}

export async function stackLogs(
  runtime: LabRuntime,
  service: string,
  tailLines: number,
  runner: DockerRunner = defaultDockerRunner,
): Promise<{ text: string; truncated: boolean }> {
  if (tailLines < 1 || tailLines > 500) throw new Error("tail-lines must be 1..500");
  const model = await normalizedComposeModel(
    runtime.composeArgs,
    runner,
    scrubSecretEnvironment(runtime.config.secretEnvironment, process.env),
  );
  if (!Object.hasOwn(model.services ?? {}, service)) throw new Error(`unknown Compose service: ${service}`);
  const result = await composeCommand(runtime, ["logs", "--no-color", "--tail", String(tailLines), service], {
    allowFailure: true, timeoutMs: 20_000,
  }, runner);
  return boundedLogTail(`${result.stdout}${result.stderr}`, tailLines, 8 * 1024);
}

function parseStatusValues(raw: string, maximum: number): unknown[] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (Array.isArray(parsed) ? parsed : [parsed]).slice(0, maximum);
  } catch {
    try {
      return raw.split("\n").filter(Boolean).slice(0, maximum).map((line) => JSON.parse(line) as unknown);
    } catch {
      return undefined;
    }
  }
}

function summarizeServices(values: unknown[], maximum = 16): ServiceSummary[] {
  return values.slice(0, maximum).flatMap((value) => {
    if (!isRecord(value)) return [];
    const rawService = typeof value.Service === "string" ? value.Service : typeof value.Name === "string" ? value.Name : undefined;
    const rawState = typeof value.State === "string" ? value.State : undefined;
    if (!rawService || !rawState) return [];
    const service = rawService.slice(0, 128);
    const state = sanitizeDiagnosticField(rawState, 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service) || !state) return [];
    const summary: ServiceSummary = { service, state };
    if (typeof value.Health === "string" && value.Health) {
      const health = sanitizeDiagnosticField(value.Health, 64);
      if (health) summary.health = health;
    }
    const exitCode = typeof value.ExitCode === "number" ? value.ExitCode :
      typeof value.ExitCode === "string" && value.ExitCode.trim() !== "" ? Number(value.ExitCode) : undefined;
    if (exitCode !== undefined && Number.isInteger(exitCode) && exitCode >= -1 && exitCode <= 255) {
      summary.exitCode = exitCode;
    }
    return [summary];
  });
}

function sanitizeDiagnosticField(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "�").slice(0, maximum);
}

export function boundedLogTail(value: string, maxLines: number, maxBytes: number): { text: string; truncated: boolean } {
  const sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�").trimEnd();
  const lines = sanitized.split("\n");
  let selected = lines.slice(-maxLines).join("\n");
  let truncated = lines.length > maxLines;
  let bytes = Buffer.from(selected);
  if (bytes.byteLength > maxBytes) {
    bytes = bytes.subarray(bytes.byteLength - maxBytes);
    selected = bytes.toString("utf8").replace(/^�/, "");
    truncated = true;
  }
  return { text: selected, truncated };
}

function compactError(value: string): string {
  return redactPublicText(value.trim(), 2_000, 6);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
