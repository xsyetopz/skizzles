import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LabConfig } from "./config";
import {
  composeCommandArgs,
  generateBaseCompose,
  generateOverrideCompose,
  inspectComposeModel,
  validateSecretEnvironmentModel,
} from "./definition";
import type { CommandResult } from "../execution/process";
import type { Endpoint, LabMetadata } from "../storage/records";
import {
  defaultDockerRunner,
  secretComposeEnvironment,
  type DockerRunner,
} from "./docker-runner";
import { normalizedComposeModel } from "./compose-model";
import { composeCommand } from "./compose-command";
import {
  captureComposeFailure,
  DockerProvisioningFailure,
  PROVISIONING_FAILURE_DIAGNOSTIC_FILE,
} from "./diagnostics";
import { stackLogs, stackStatus } from "./status";
import type { LabRuntime } from "./runtime-model";

export type { LabRuntime } from "./runtime-model";
export { composeCommand } from "./compose-command";
export {
  DockerProvisioningFailure,
  PROVISIONING_FAILURE_DIAGNOSTIC_FILE,
} from "./diagnostics";
export { stackLogs, stackStatus } from "./status";

export async function prepareLabRuntime(
  metadata: LabMetadata,
  config: LabConfig,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LabRuntime> {
  await mkdir(metadata.runtimeRoot, { recursive: true, mode: 0o700 });
  const base = generateBaseCompose(config);
  const baseFile = base === undefined ? undefined : join(metadata.runtimeRoot, "base.compose.yaml");
  if (baseFile && base !== undefined) await writeFile(baseFile, base, { mode: 0o600 });
  const overrideFile = join(metadata.runtimeRoot, "override.compose.yaml");
  await writeFile(overrideFile, "{}\n", { mode: 0o600 });
  const composeArgs = composeCommandArgs(config, { projectName: metadata.composeProject, overrideFile, baseFile });
  const composeEnvironment = secretComposeEnvironment(config.secretEnvironment, environment);
  const sourceModel = await normalizedComposeModel(composeArgs, runner, composeEnvironment);
  validateSecretEnvironmentModel(sourceModel, config.secretEnvironment, composeEnvironment);
  const findings = inspectComposeModel(sourceModel);
  const override = generateOverrideCompose(config, sourceModel, {
    workspaceHostPath: metadata.workspace,
    owner: metadata.owner,
    ownerKey: metadata.ownerKey,
    labId: metadata.id,
  });
  await writeFile(overrideFile, override, { mode: 0o600 });
  const finalModel = await normalizedComposeModel(composeArgs, runner, composeEnvironment);
  validateSecretEnvironmentModel(finalModel, config.secretEnvironment, composeEnvironment);
  return { metadata, config, composeArgs, baseFile, overrideFile, findings };
}

export async function provisionLabStack(
  runtime: LabRuntime,
  signal?: AbortSignal,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Endpoint[]> {
  let provisioned: CommandResult;
  try {
    provisioned = await runner.run([...runtime.composeArgs, "up", "-d", "--wait", "--wait-timeout", "180"], {
      timeoutMs: 30 * 60_000,
      signal,
      allowFailure: true,
      maxOutputBytes: 4 * 1024 * 1024,
      stdoutCapture: "tail",
      stderrCapture: "tail",
      env: secretComposeEnvironment(runtime.config.secretEnvironment, environment),
    });
  } catch {
    const message = signal?.aborted
      ? "Docker Compose up aborted; secret-bearing diagnostics redacted"
      : "Docker Compose up failed; secret-bearing diagnostics redacted";
    throw new DockerProvisioningFailure(message, await captureComposeFailure(runtime, undefined, runner, environment));
  }
  if (provisioned.code !== 0) {
    throw new DockerProvisioningFailure(
      "Docker Compose up failed; secret-bearing diagnostics redacted",
      await captureComposeFailure(runtime, provisioned, runner, environment),
    );
  }
  const compatibility = [
    `test -d ${shellQuote(runtime.config.runtime.workspace)}`,
    `test -w ${shellQuote(runtime.config.runtime.workspace)}`,
    "command -v setsid >/dev/null 2>&1",
  ].join(" && ");
  const verified = await composeCommand(runtime, [
    "exec", "-T", runtime.config.mode.commandService, ...runtime.config.runtime.shell, compatibility,
  ], { allowFailure: true, timeoutMs: 20_000, signal }, runner);
  if (verified.code !== 0) {
    throw new Error("command service compatibility check failed: configured shell, writable workspace, and setsid are required");
  }
  const endpoints: Endpoint[] = [];
  for (const port of runtime.config.ports) {
    const result = await composeCommand(runtime, ["port", port.service, String(port.target)], { timeoutMs: 20_000 }, runner);
    const loopback = result.stdout.toString().trim().split("\n")
      .map((line) => line.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1])
      .filter((value): value is string => value !== undefined);
    if (loopback.length !== 1) throw new Error(`unable to uniquely resolve declared loopback port ${port.name}`);
    endpoints.push({
      name: port.name,
      service: port.service,
      target: port.target,
      url: `${port.scheme ?? "tcp"}://127.0.0.1:${loopback[0]!}`,
    });
  }
  return endpoints;
}

export function runtimeFromLab(metadata: LabMetadata): LabRuntime {
  if (!metadata.runtime) throw new Error(`lab runtime is unavailable: ${metadata.id}`);
  return { metadata, ...metadata.runtime };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
