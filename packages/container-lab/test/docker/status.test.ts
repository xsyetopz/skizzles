import { describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  type DockerRunner,
  type DockerSpawnOptions,
  type LabRuntime,
  stackLogs,
  stackStatus,
} from "../../src/docker.ts";
import type { CommandResult, RunOptions } from "../../src/process.ts";
import type { LabMetadata } from "../../src/state/lab/contract.ts";

class MockDocker implements DockerRunner {
  calls: string[][] = [];
  spawnCalls: string[][] = [];
  spawnOptions: Array<DockerSpawnOptions | undefined> = [];
  responses: CommandResult[] = [];

  async run(args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    return this.responses.shift() ?? result("");
  }
  spawn(
    args: string[],
    options?: DockerSpawnOptions,
  ): ChildProcessWithoutNullStreams {
    this.spawnCalls.push(args);
    this.spawnOptions.push(options);
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

describe("bounded Docker status output", () => {
  it("service logs enforce both line and hard UTF-8 byte caps", async () => {
    const docker = new MockDocker();
    docker.responses.push(
      result('{"services":{"dev":{}}}'),
      result(
        Array.from(
          { length: 900 },
          (_, index) => `${index}: ${'\\"'.repeat(40)}`,
        ).join("\n"),
      ),
    );
    const transcript = await stackLogs(runtime(), "dev", 500, docker);
    expect(transcript.truncated).toBe(true);
    expect(Buffer.byteLength(transcript.text)).toBeLessThanOrEqual(8 * 1024);
    expect(transcript.text.split("\n").length).toBeLessThanOrEqual(500);
    expect(
      Buffer.byteLength(
        JSON.stringify({ labId: "lab-1", service: "dev", transcript }),
      ),
    ).toBeLessThan(16 * 1024);
  });

  it("stack status reduces Compose output to purpose-built service summaries", async () => {
    const docker = new MockDocker();
    docker.responses.push(
      result(
        JSON.stringify([
          {
            Service: "dev",
            State: "running",
            Health: "healthy",
            ExitCode: 0,
            ID: "container-secret",
            Project: "internal-project",
            Publishers: [{ URL: "0.0.0.0" }],
          },
        ]),
      ),
    );
    expect(await stackStatus(runtime(), docker)).toEqual({
      available: true,
      services: [
        { service: "dev", state: "running", health: "healthy", exitCode: 0 },
      ],
    });
  });

  it("stack status failures redact internal paths, owner hashes, projects, and image bookkeeping", async () => {
    const docker = new MockDocker();
    docker.responses.push(
      resultWithError(
        `compose -f /private/tmp/runtime/override.yaml --project-name ccl-secret failed for ${"a".repeat(
          64,
        )} codex-container-lab:private-image`,
      ),
    );
    const encoded = JSON.stringify(await stackStatus(runtime(), docker));
    expect(encoded).toContain("[path]");
    expect(encoded).not.toContain("/private/tmp");
    expect(encoded).not.toContain("a".repeat(64));
    expect(encoded).not.toContain("ccl-secret");
    expect(encoded).not.toContain("private-image");
  });
});

function runtime(): LabRuntime {
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
      composeEnvironment: [],
      secretEnvironment: [],
    },
    composeArgs: [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-directory",
      "/tmp/source",
      "--project-name",
      "ccl-project",
      "-f",
      "/tmp/runtime/source.compose.json",
      "-f",
      "/tmp/runtime/override.compose.yaml",
    ],
    sourceFile: "/tmp/runtime/source.compose.json",
    overrideFile: "/tmp/runtime/override.compose.yaml",
    findings: [],
  };
}
function lab(): LabMetadata {
  return {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner: "thread/exact",
    ownerKey: "a".repeat(64),

    repoHash: ["123456", "789abc"].join(""),
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
    composeEnvironment: [],
    secretEnvironment: [],
  };
}
function result(stdout: string, code = 0): CommandResult {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function resultWithError(stderr: string): CommandResult {
  return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) };
}
