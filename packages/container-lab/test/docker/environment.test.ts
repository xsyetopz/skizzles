// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLabConfig } from "../../src/config.ts";
import {
  cleanupLabLabels,
  type DockerRunner,
  type DockerRunOptions,
  type DockerSpawnOptions,
  launchDockerRun,
  prepareLabRuntime,
  provisionLabStack,
} from "../../src/docker.ts";
import type { CommandResult } from "../../src/process.ts";
import { dockerLab } from "./support.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class ModelDocker implements DockerRunner {
  readonly calls: Array<{ args: string[]; options: DockerRunOptions }> = [];
  readonly models: unknown[];
  constructor(...models: unknown[]) {
    this.models = models;
  }
  run(args: string[], options: DockerRunOptions): Promise<CommandResult> {
    this.calls.push({ args, options });
    return Promise.resolve({
      code: 0,
      stdout: Buffer.from(JSON.stringify(this.models.shift() ?? {})),
      stderr: Buffer.alloc(0),
    });
  }
  spawn(
    _args: string[],
    _options: DockerSpawnOptions,
  ): ChildProcessWithoutNullStreams {
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

class SecretDocker implements DockerRunner {
  readonly calls: Array<{ args: string[]; options: DockerRunOptions }> = [];
  readonly spawnCalls: Array<{
    args: string[];
    options: DockerSpawnOptions;
  }> = [];
  failConfig = false;
  failUp = false;
  readonly sentinel: string;
  constructor(sentinel: string) {
    this.sentinel = sentinel;
  }
  run(args: string[], options: DockerRunOptions): Promise<CommandResult> {
    this.calls.push({ args, options });
    if (args.includes("config")) {
      return Promise.resolve(
        this.failConfig
          ? result("", 1, `configuration echoed ${this.sentinel}`)
          : result(
              JSON.stringify({
                services: { dev: {} },
                secrets: {
                  registry: { environment: "REGISTRY_TOKEN" },
                },
              }),
            ),
      );
    }
    if (args.includes("up") && this.failUp) {
      return Promise.resolve(result("", 1, `up echoed ${this.sentinel}`));
    }
    return Promise.resolve(result(""));
  }
  spawn(
    args: string[],
    options: DockerSpawnOptions,
  ): ChildProcessWithoutNullStreams {
    this.spawnCalls.push({ args, options });
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

describe("raw Compose environment boundary", () => {
  test("rejects undeclared HOME before generating an override", async () => {
    const root = await temporaryRoot();
    const docker = new ModelDocker({
      services: { dev: { command: "echo ${HOME}" } },
    });
    const config = parseLabConfig(
      "image: { name: node:24, service: dev }\n",
      join(root, "source"),
    );

    await expect(
      prepareLabRuntime(metadata(root), config, docker, {
        PATH: "/usr/bin:/bin",
        HOME: "/ambient/client-home",
        COMPOSE_PROJECT_NAME: "ambient-project",
      }),
    ).rejects.toThrow("interpolation reads undeclared environment: HOME");

    expect(docker.calls).toHaveLength(1);
    expect(docker.calls[0]?.args.slice(-6)).toEqual([
      "config",
      "--no-interpolate",
      "--no-normalize",
      "--no-env-resolution",
      "--format",
      "json",
    ]);
    expect(docker.calls[0]?.args).not.toContain("override.compose.yaml");
    expect(docker.calls[0]?.options.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/ambient/client-home",
    });
  });

  test("forwarding alone cannot authorize source interpolation", async () => {
    const root = await temporaryRoot();
    const model = { services: { dev: { command: "echo $PROJECT_VALUE" } } };
    const docker = new ModelDocker(model);
    const config = parseLabConfig(
      "image: { name: node:24, service: dev }\nenvironment: [PROJECT_VALUE]\n",
      join(root, "source"),
    );

    await expect(
      prepareLabRuntime(metadata(root), config, docker, {
        PATH: "/usr/bin:/bin",
        PROJECT_VALUE: "present",
      }),
    ).rejects.toThrow(
      "interpolation reads undeclared environment: PROJECT_VALUE",
    );
  });

  test("rejects raw implicit reads and environment-backed configs", async () => {
    for (const model of [
      { services: { dev: { environment: { IMPLICIT_VALUE: null } } } },
      {
        services: {
          dev: { build: { args: { IMPLICIT_VALUE: null } } },
        },
      },
      {
        services: { dev: {} },
        configs: { unsupported: { environment: "CONFIG_VALUE" } },
      },
    ]) {
      const root = await temporaryRoot();
      const docker = new ModelDocker(model);
      const config = parseLabConfig(
        "image: { name: node:24, service: dev }\n",
        join(root, "source"),
      );
      await expect(
        prepareLabRuntime(metadata(root), config, docker, {
          PATH: "/usr/bin:/bin",
          IMPLICIT_VALUE: "ambient",
          CONFIG_VALUE: "ambient",
        }),
      ).rejects.toThrow(/undeclared environment|not supported/);
      expect(docker.calls).toHaveLength(1);
    }
  });

  test("declared Compose environment authorizes raw reads and reaches no other names", async () => {
    const root = await temporaryRoot();
    const raw = {
      services: {
        dev: {
          command: "echo ${PROJECT_VALUE:-fallback}",
          environment: { PROJECT_VALUE: null },
          build: { args: { PROJECT_VALUE: null } },
        },
      },
    };
    const final = { services: { dev: {} } };
    const docker = new ModelDocker(raw, final);
    const config = parseLabConfig(
      "image: { name: node:24, service: dev }\ncompose_environment: [PROJECT_VALUE]\n",
      join(root, "source"),
    );

    const prepared = await prepareLabRuntime(metadata(root), config, docker, {
      PATH: "/usr/bin:/bin",
      PROJECT_VALUE: "present",
      UNDECLARED_VALUE: "absent",
    });

    expect(prepared.config.composeEnvironment).toEqual(["PROJECT_VALUE"]);
    expect(docker.calls).toHaveLength(2);
    for (const call of docker.calls) {
      expect(call.options.env).toEqual({
        PATH: "/usr/bin:/bin",
        PROJECT_VALUE: "present",
      });
    }
  });
});

describe("secret environment materialization", () => {
  test("rejects service env_file before secret values or durable materialization", async () => {
    const root = await temporaryRoot();
    const docker = new ModelDocker({
      services: {
        dev: { env_file: [{ path: join(root, "source", "values.env") }] },
      },
      secrets: { registry: { environment: "REGISTRY_TOKEN" } },
    });
    const config = parseLabConfig(
      "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n",
      join(root, "source"),
    );

    await expect(
      prepareLabRuntime(metadata(root), config, docker, {
        PATH: "/usr/bin:/bin",
        REGISTRY_TOKEN: "sentinel-secret",
      }),
    ).rejects.toThrow("Compose service env_file is not supported");

    expect(docker.calls).toHaveLength(1);
    expect(
      await Bun.file(join(root, "runtime", "source.compose.json")).exists(),
    ).toBe(false);
    expect(docker.calls.some((call) => call.args.includes("up"))).toBe(false);
  });

  test("keeps values ephemeral and supplies them only to Compose up", async () => {
    const root = await temporaryRoot();
    const sentinel = "sentinel-registry-token-8fca7b";
    const docker = new SecretDocker(sentinel);
    const config = parseLabConfig(
      "image: { name: node:24, service: dev }\nenvironment: [TERM]\nsecret_environment: [REGISTRY_TOKEN]\n",
      join(root, "source"),
    );
    const lab = metadata(root);
    lab.secretEnvironment = ["REGISTRY_TOKEN"];
    const environment = {
      PATH: "/usr/bin:/bin",
      TERM: "xterm",
      REGISTRY_TOKEN: sentinel,
    };

    const prepared = await prepareLabRuntime(lab, config, docker, environment);
    await provisionLabStack(prepared, undefined, docker, environment);
    launchDockerRun(
      prepared,
      {
        runId: "11111111-1111-4111-8111-111111111111",
        cwd: ".",
        argv: ["true"],
        environment: {},
      },
      docker,
      environment,
    );
    await cleanupLabLabels(lab, false, docker, environment);

    expect(JSON.stringify({ lab, prepared })).not.toContain(sentinel);
    expect(
      prepared.findings.some((finding) => finding.surface === "secret"),
    ).toBe(true);
    expect(JSON.stringify(prepared.findings)).not.toContain("REGISTRY_TOKEN");
    expect(prepared.baseFile).toBeUndefined();
    expect(await readFile(prepared.sourceFile, "utf8")).not.toContain(sentinel);
    expect(await readFile(prepared.overrideFile, "utf8")).not.toContain(
      sentinel,
    );

    const carryingSecret = docker.calls.filter(
      (call) => call.options.env["REGISTRY_TOKEN"] === sentinel,
    );
    expect(carryingSecret).toHaveLength(1);
    expect(carryingSecret[0]?.args).toContain("up");
    expect(docker.calls.every((call) => call.options.env !== undefined)).toBe(
      true,
    );
    for (const call of docker.calls.filter(
      (call) => !call.args.includes("up"),
    )) {
      expect(Object.hasOwn(call.options.env, "REGISTRY_TOKEN")).toBe(false);
    }
    expect(docker.spawnCalls).toHaveLength(1);
    expect(
      Object.hasOwn(docker.spawnCalls[0]?.options.env ?? {}, "REGISTRY_TOKEN"),
    ).toBe(false);
  });

  test("replaces secret-bearing Compose diagnostics with fixed errors", async () => {
    const root = await temporaryRoot();
    const sentinel = "sentinel-error-token-290ea1";
    const config = parseLabConfig(
      "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n",
      join(root, "source"),
    );
    const environment = { PATH: "/usr/bin:/bin", REGISTRY_TOKEN: sentinel };
    const configFailure = new SecretDocker(sentinel);
    configFailure.failConfig = true;
    const configError = await captureError(
      prepareLabRuntime(metadata(root), config, configFailure, environment),
    );
    expect(configError.message).toBe(
      "Docker Compose configuration failed; secret-bearing diagnostics redacted",
    );
    expect(configError.message).not.toContain(sentinel);

    const upFailure = new SecretDocker(sentinel);
    const prepared = await prepareLabRuntime(
      metadata(root),
      config,
      upFailure,
      environment,
    );
    upFailure.failUp = true;
    const upError = await captureError(
      provisionLabStack(prepared, undefined, upFailure, environment),
    );
    expect(upError.message).toBe(
      "Docker Compose up failed; secret-bearing diagnostics redacted",
    );
    expect(upError.message).not.toContain(sentinel);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "container-lab-compose-env-"));
  roots.push(root);
  return root;
}

function metadata(root: string) {
  return dockerLab({
    runtimeRoot: join(root, "runtime"),
    workspace: join(root, "runtime", "workspace"),
  });
}

function result(stdout: string, code = 0, stderr = ""): CommandResult {
  return {
    code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("expected operation to reject with an Error");
}
