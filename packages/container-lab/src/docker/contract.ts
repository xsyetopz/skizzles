import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { CommandResult, RunOptions } from "../process/contract.ts";
import type {
  LabMetadata,
  PersistedLabRuntime,
} from "../state/lab/contract.ts";

export type LabRuntime = PersistedLabRuntime & { metadata: LabMetadata };
export type BoundLabRuntime = LabRuntime & { sourceFile: string };

export interface DockerRunner {
  run: (args: string[], options: DockerRunOptions) => Promise<CommandResult>;
  spawn: (
    args: string[],
    options: DockerSpawnOptions,
  ) => ChildProcessWithoutNullStreams;
}

export interface DockerRunOptions extends RunOptions {
  env: NodeJS.ProcessEnv;
}

export interface DockerSpawnOptions {
  env: NodeJS.ProcessEnv;
}

export type DockerRunTerminationResult =
  | { confirmed: true; status: "signaled" | "absent" }
  | {
      confirmed: false;
      status: "identity-mismatch" | "unavailable" | "docker-failure";
    };

export interface DockerRunIdentity {
  runId: string;
  cwd: string;
  argv: string[];
  environment: Record<string, string>;
}
