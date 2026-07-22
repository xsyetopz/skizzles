import { describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import * as dockerFacade from "../../src/docker.ts";
import {
  cleanupLabLabels,
  type DockerRunner,
  type DockerSpawnOptions,
  type LabRuntime,
  launchDockerRun,
  terminateDockerRun,
} from "../../src/docker.ts";
import type { CommandResult, RunOptions } from "../../src/process.ts";
import type { LabMetadata } from "../../src/state/lab/contract.ts";

const OWNERSHIP_ERROR = /ownership|exact ownership labels/u;

it("Docker domain facade exposes its supported runtime surface", () => {
  expect(Object.keys(dockerFacade).sort()).toEqual([
    "cleanupLabLabels",
    "composeCommand",
    "defaultDockerRunner",
    "destroyLabStack",
    "dockerAvailable",
    "launchDockerRun",
    "prepareLabRuntime",
    "provisionLabStack",
    "runtimeFromLab",
    "stackLogs",
    "stackStatus",
    "terminateDockerRun",
  ]);
});

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

describe("exact Docker cleanup", () => {
  it("uses managed + exact owner + exact lab filters and Compose ownership filters", async () => {
    const docker = new MockDocker();
    await cleanupLabLabels(lab(), false, docker);
    const listCalls = docker.calls.filter((args) => args.includes("--filter"));
    expect(listCalls).toHaveLength(6);
    for (const args of listCalls) {
      expect(args).toContain(
        "label=io.openai.codex-container-lab.managed=true",
      );
      expect(args).toContain(
        "label=io.openai.codex-container-lab.owner=thread/exact",
      );
      expect(args).toContain("label=io.openai.codex-container-lab.lab=lab-1");
      expect(args.join(" ")).not.toContain("prune");
    }
    for (const args of listCalls.filter(
      (args) => args[0] === "volume" || args[0] === "network",
    )) {
      expect(args).toContain("label=com.docker.compose.project=ccl-project");
      expect(args).toContain(`label=com.docker.compose.${args[0]}`);
    }
  });

  it("refuses a volume whose inspected labels do not prove exact ownership", async () => {
    const docker = new MockDocker();
    docker.responses.push(
      result(""),
      result(""),
      result("volume-id\n"),
      result(
        JSON.stringify({
          "io.openai.codex-container-lab.managed": "true",
          "io.openai.codex-container-lab.owner": "another-thread",
          "io.openai.codex-container-lab.lab": "lab-1",
          "com.docker.compose.project": "ccl-project",
          "com.docker.compose.volume": "data",
        }),
      ),
    );
    await expect(cleanupLabLabels(lab(), false, docker)).rejects.toThrow(
      "exact ownership labels",
    );
    expect(
      docker.calls.some((args) => args[0] === "volume" && args[1] === "rm"),
    ).toBe(false);
  });

  it("refuses more than 1000 exact-labelled resources", async () => {
    const docker = new MockDocker();
    docker.responses.push(
      result(
        Array.from({ length: 1001 }, (_, index) => `id-${index}`).join("\n"),
      ),
    );
    await expect(cleanupLabLabels(lab(), false, docker)).rejects.toThrow(
      "cleanup bound",
    );
    expect(docker.calls.some((args) => args.includes("rm"))).toBe(false);
  });

  it("verifies exact image labels and removes only the immutable image identity", async () => {
    const docker = new MockDocker();
    const imageId = `sha256:${"b".repeat(64)}`;
    docker.responses.push(
      ...emptyResourceListings(),
      result(
        JSON.stringify({
          id: imageId,
          labels: {
            "io.openai.codex-container-lab.managed": "true",
            "io.openai.codex-container-lab.owner": "thread/exact",
            "io.openai.codex-container-lab.lab": "lab-1",
          },
        }),
      ),
      result(""),
    );

    await cleanupLabLabels(lab(), true, docker);

    const tag = `codex-container-lab:${"a".repeat(24)}-lab-1`;
    expect(
      docker.calls
        .find((args) => args[0] === "image" && args[1] === "inspect")
        ?.at(-1),
    ).toBe(tag);
    expect(
      docker.calls.filter((args) => args[0] === "image" && args[1] === "rm"),
    ).toEqual([["image", "rm", imageId]]);
  });

  it("refuses malformed or mismatched internal image inspection", async () => {
    for (const inspection of [
      "not-json",
      JSON.stringify({ id: "mutable-tag", labels: exactImageLabels() }),
      JSON.stringify({
        id: `sha256:${"b".repeat(64)}`,
        labels: {
          ...exactImageLabels(),
          "io.openai.codex-container-lab.owner": "another-thread",
        },
      }),
    ]) {
      const docker = new MockDocker();
      docker.responses.push(...emptyResourceListings(), result(inspection));
      await expect(cleanupLabLabels(lab(), true, docker)).rejects.toThrow(
        OWNERSHIP_ERROR,
      );
      expect(
        docker.calls.some((args) => args[0] === "image" && args[1] === "rm"),
      ).toBe(false);
    }
  });

  it("tolerates only an exact missing-image inspection response", async () => {
    const tag = `codex-container-lab:${"a".repeat(24)}-lab-1`;
    const absent = new MockDocker();
    absent.responses.push(
      ...emptyResourceListings(),
      resultWithError(`Error response from daemon: No such image: ${tag}`),
    );
    await expect(
      cleanupLabLabels(lab(), true, absent),
    ).resolves.toBeUndefined();
    expect(
      absent.calls.some((args) => args[0] === "image" && args[1] === "rm"),
    ).toBe(false);

    const uncertain = new MockDocker();
    uncertain.responses.push(
      ...emptyResourceListings(),
      resultWithError(`daemon unavailable; No such image: ${tag}`),
    );
    await expect(cleanupLabLabels(lab(), true, uncertain)).rejects.toThrow(
      "unable to inspect",
    );
    expect(
      uncertain.calls.some((args) => args[0] === "image" && args[1] === "rm"),
    ).toBe(false);
  });

  it("binds cancellation to an ephemeral run identity and removes the pid file on normal completion", async () => {
    const docker = new MockDocker();
    const identity = {
      runId: "11111111-1111-4111-8111-111111111111",
      cwd: ".",
      argv: ["echo", "hello"],
      environment: {},
    };
    launchDockerRun(runtime(), identity, docker);
    const spawned = docker.spawnCalls[0];
    if (!spawned) {
      throw new Error("expected Docker spawn arguments");
    }
    const shell = spawned.indexOf("/bin/sh");
    expect(spawned.slice(shell, shell + 2)).toEqual(["/bin/sh", "-lc"]);
    const wrapper = spawned[shell + 2];
    if (!wrapper) {
      throw new Error("expected attached-run shell wrapper");
    }
    expect(wrapper).toContain(`CODEX_CONTAINER_LAB_RUN_ID=${identity.runId}`);
    expect(wrapper).toContain("exec 3<&0");
    expect(wrapper).toContain('setsid "$@" <&3 3<&- & child=$!');
    expect(wrapper).toContain("exec 3<&-");
    expect(wrapper).toContain('temporary_directory=$(dirname "$(mktemp -u)")');
    expect(wrapper).toContain(`printf '%s %s\\n' '${identity.runId}'`);
    expect(wrapper).toContain(
      `pid_file="$temporary_directory/.codex-container-lab-run-${identity.runId}.pid"`,
    );
    expect(wrapper).toContain('rm -f "$pid_file"');
    expect(wrapper).not.toContain("/tmp");
    expect(wrapper).toContain('kill -TERM -- -"$child"');
    expect(wrapper).toContain('kill -KILL -- -"$child"');
    expect(wrapper.indexOf("kill -KILL")).toBeLessThan(
      wrapper.indexOf("rm -f"),
    );

    docker.responses.push(result("codex-container-lab-termination:signaled\n"));
    const termination = await terminateDockerRun(
      runtime(),
      identity,
      "TERM",
      docker,
    );
    expect(termination).toEqual({ confirmed: true, status: "signaled" });
    const killScript = docker.calls.at(-1)?.at(-1);
    if (!killScript) {
      throw new Error("expected termination script");
    }
    expect(killScript).toContain("/proc/$pid/environ");
    expect(killScript).toContain(
      'temporary_directory=$(dirname "$(mktemp -u)")',
    );
    expect(killScript).not.toContain("/tmp");
    expect(killScript).toContain(
      `CODEX_CONTAINER_LAB_RUN_ID=${identity.runId}`,
    );
    expect(killScript).toContain(`[ "$recorded_token" = '${identity.runId}' ]`);
    expect(killScript).toContain("grep -Fqx");
    expect(killScript).toContain('kill -TERM -- -"$pid"');
  });

  it("preserves redirected stdin for the background attached command", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-stdin-"));
    try {
      const setsid = join(root, "setsid");
      await writeFile(setsid, '#!/bin/sh\nexec "$@"\n');
      await chmod(setsid, 0o755);
      const docker: DockerRunner = {
        run: async () => result(""),
        spawn: (args, options) => {
          const shell = args.indexOf("/bin/sh");
          const command = args[shell];
          if (!command) {
            throw new Error("missing shell command");
          }
          return spawn(command, args.slice(shell + 1), {
            env: {
              ...options?.env,
              PATH: `${root}:${process.env["PATH"] ?? ""}`,
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
        },
      };
      const child = launchDockerRun(
        runtime(),
        {
          runId: "22222222-2222-4222-8222-222222222222",
          cwd: ".",
          argv: ["cat"],
          environment: {},
        },
        docker,
      );
      child.stdin.end("stdin-forwarded\n");
      const [stdout, stderr, code] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
        new Promise<number>((resolve) =>
          child.once("close", (value) => resolve(value ?? 1)),
        ),
      ]);
      expect({ stdout, stderr, code }).toEqual({
        stdout: "stdin-forwarded\n",
        stderr: "",
        code: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports token mismatch and Docker exec failure as unconfirmed termination", async () => {
    const mismatch = new MockDocker();
    mismatch.responses.push(
      result("codex-container-lab-termination:identity-mismatch\n"),
    );
    expect(
      await terminateDockerRun(runtime(), { runId: "run-1" }, "KILL", mismatch),
    ).toEqual({
      confirmed: false,
      status: "identity-mismatch",
    });

    const failed = new MockDocker();
    failed.responses.push(resultWithError("Docker service unavailable"));
    expect(
      await terminateDockerRun(runtime(), { runId: "run-1" }, "KILL", failed),
    ).toEqual({
      confirmed: false,
      status: "docker-failure",
    });
  });

  it("reports an exact recorded process group absence as confirmed", async () => {
    const docker = new MockDocker();
    docker.responses.push(result("codex-container-lab-termination:absent\n"));
    expect(
      await terminateDockerRun(runtime(), { runId: "run-1" }, "KILL", docker),
    ).toEqual({
      confirmed: true,
      status: "absent",
    });
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

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.once("error", reject);
  });
}

function lab(): LabMetadata {
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

function emptyResourceListings(): CommandResult[] {
  return Array.from({ length: 6 }, () => result(""));
}

function exactImageLabels(): Record<string, string> {
  return {
    "io.openai.codex-container-lab.managed": "true",
    "io.openai.codex-container-lab.owner": "thread/exact",
    "io.openai.codex-container-lab.lab": "lab-1",
  };
}
