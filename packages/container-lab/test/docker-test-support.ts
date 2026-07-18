import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  DockerRunner,
  DockerSpawnOptions,
  LabRuntime,
} from "../src/docker.ts";
import type { CommandResult, RunOptions } from "../src/process.ts";
import type { LabMetadata } from "../src/types.ts";

export class RecordingDocker implements DockerRunner {
  readonly calls: Array<{ args: string[]; options?: RunOptions }> = [];
  readonly spawnCalls: Array<{
    args: string[];
    options?: DockerSpawnOptions;
  }> = [];
  readonly responses: CommandResult[] = [];
  runError: Error | undefined;

  run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ args, ...(options === undefined ? {} : { options }) });
    if (this.runError) {
      return Promise.reject(this.runError);
    }
    return Promise.resolve(this.responses.shift() ?? commandResult(""));
  }

  spawn(
    args: string[],
    options?: DockerSpawnOptions,
  ): ChildProcessWithoutNullStreams {
    this.spawnCalls.push({
      args,
      ...(options === undefined ? {} : { options }),
    });
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

export function commandResult(
  stdout: string,
  code = 0,
  stderr = "",
): CommandResult {
  return {
    code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

export function dockerLab(overrides: Partial<LabMetadata> = {}): LabMetadata {
  return {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner: "thread/exact",
    ownerKey: "a".repeat(64),
    // biome-ignore lint/security/noSecrets: This fixed test/schema token is not a credential.
    repoHash: "123456789abc",
    composeProject: "ccl-project",
    state: "failed",
    sourceRoot: "/tmp/source",
    runtimeRoot: "/tmp/runtime",
    workspace: "/tmp/runtime/workspace",
    manifestPath: "/tmp/source/.codex-container-lab.yaml",
    commandService: "dev",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment: [],
    ...overrides,
  };
}

export function dockerRuntime(metadata: LabMetadata = dockerLab()): LabRuntime {
  return {
    metadata,
    config: {
      repoRoot: "/tmp/source",
      manifestPath: "/tmp/source/.codex-container-lab.yaml",
      mode: { kind: "image", image: "node:24", commandService: "dev" },
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      secretEnvironment: metadata.secretEnvironment,
    },
    composeArgs: ["compose", "--project-name", "ccl-project"],
    overrideFile: "/tmp/runtime/override.compose.yaml",
    findings: [],
  };
}
