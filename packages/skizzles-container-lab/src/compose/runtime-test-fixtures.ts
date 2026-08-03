import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import type { DockerRunner, DockerSpawnOptions } from "./docker-runner";
import type { RunOptions, CommandResult } from "../execution/process";
import type { LabRuntime } from "./runtime-model";
import type { LabMetadata } from "../storage/records";

export class MockDocker implements DockerRunner {
  calls: string[][] = [];
  spawnCalls: string[][] = [];
  spawnOptions: Array<DockerSpawnOptions | undefined> = [];
  responses: Array<CommandResult> = [];
  async run(args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    return this.responses.shift() ?? result("");
  }
  spawn(args: string[], options?: DockerSpawnOptions): ChildProcessWithoutNullStreams {
    this.spawnCalls.push(args);
    this.spawnOptions.push(options);
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

export class SecretRecordingDocker implements DockerRunner {
  calls: Array<{ args: string[]; options?: RunOptions }> = [];
  spawnCalls: Array<{ args: string[]; options?: DockerSpawnOptions }> = [];
  failConfig = false;
  failUp = false;
  constructor(readonly sentinel: string) {}
  async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ args, options });
    if (args.includes("config")) {
      if (this.failConfig) return resultWithError(`configuration echoed ${this.sentinel}`);
      return result(JSON.stringify({
        services: { dev: {} },
        secrets: { registry: { environment: "REGISTRY_TOKEN" } },
      }));
    }
    if (args.includes("up") && this.failUp) return resultWithError(`up echoed ${this.sentinel}`);
    return result("");
  }
  spawn(args: string[], options?: DockerSpawnOptions): ChildProcessWithoutNullStreams {
    this.spawnCalls.push({ args, options });
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

export class ComposeFailureDocker implements DockerRunner {
  calls: string[][] = [];
  constructor(readonly sentinel: string, readonly psOutput: string) {}
  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    if (args.includes("config")) return result(JSON.stringify({ services: { dev: {} } }));
    if (args.includes("up")) return resultWithError(`failed ${this.sentinel} /private/tmp/ccl-project ${"a".repeat(64)}`);
    if (args.includes("ps") && args.includes("--all")) return result(this.psOutput);
    return result("");
  }
  spawn(): ChildProcessWithoutNullStreams { return new EventEmitter() as ChildProcessWithoutNullStreams; }
}

export function runtime(): LabRuntime {
  const metadata = lab();
  return {
    metadata,
    config: {
      repoRoot: "/tmp/source",
      manifestPath: "/tmp/source/.codex-container-lab.yaml",
      mode: { kind: "image", image: "node:24", commandService: "dev" },
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      secretEnvironment: [],
    },
    composeArgs: ["compose", "--project-name", "ccl-project"],
    overrideFile: "/tmp/runtime/override.compose.yaml",
    findings: [],
  };
}

export async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.once("error", reject);
  });
}

export function lab(): LabMetadata {
  return {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner: "thread/exact",
    ownerKey: "a".repeat(64),
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
  };
}

export function labAt(root: string): LabMetadata {
  const runtimeRoot = join(root, "runtime");
  return {
    ...lab(),
    sourceRoot: join(root, "source"),
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(root, "source", ".codex-container-lab.yaml"),
  };
}

export function result(stdout: string, code = 0): CommandResult {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

export function resultWithError(stderr: string): CommandResult {
  return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) };
}

export function emptyResourceListings(): CommandResult[] {
  return Array.from({ length: 6 }, () => result(""));
}

export function exactImageLabels(): Record<string, string> {
  return {
    "io.openai.codex-container-lab.managed": "true",
    "io.openai.codex-container-lab.owner": "thread/exact",
    "io.openai.codex-container-lab.lab": "lab-1",
  };
}
