import { parse as parseYaml } from "yaml";
import type { LabConfig } from "./config";
import type { CommandResult } from "../execution/process";
import type { ComposeModel } from "./definition";
import type { DockerRunner } from "./docker-runner";

export async function normalizedComposeModel(
  composeArgs: string[],
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ComposeModel> {
  let result: CommandResult;
  try {
    result = await runner.run([...composeArgs, "config", "--no-interpolate", "--format", "json"], {
      timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024, allowFailure: true, env: environment,
    });
  } catch {
    throw new Error("Docker Compose configuration failed; secret-bearing diagnostics redacted");
  }
  if (result.code === 0) {
    try { return JSON.parse(result.stdout.toString()) as ComposeModel; } catch {}
  }
  let yaml: CommandResult;
  try {
    yaml = await runner.run([...composeArgs, "config", "--no-interpolate"], {
      timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024, allowFailure: true, env: environment,
    });
  } catch {
    throw new Error("Docker Compose configuration failed; secret-bearing diagnostics redacted");
  }
  if (yaml.code !== 0) throw new Error("Docker Compose configuration failed; secret-bearing diagnostics redacted");
  return parseYaml(yaml.stdout.toString()) as ComposeModel;
}
