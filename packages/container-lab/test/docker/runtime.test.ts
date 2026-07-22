import { expect, it } from "bun:test";
import {
  composeInvocationEnvironment,
  composeUpEnvironment,
  dockerClientEnvironment,
} from "../../src/docker/environment.ts";
import {
  composeCommand,
  dockerAvailable,
  runtimeFromLab,
  stackLogs,
} from "../../src/docker.ts";
import {
  commandResult,
  dockerLab,
  dockerRuntime,
  RecordingDocker,
} from "./support.ts";

it("Docker availability uses only exact client environment capabilities", async () => {
  const docker = new RecordingDocker();
  docker.responses.push(commandResult("", 1));
  const environment = {
    PATH: "/usr/bin:/bin",
    TOKEN: "sentinel",
    COMPOSE_PROJECT_NAME: "ambient-topology",
    DOCKER_HOST_OVERRIDE: "prefix-must-not-match",
  };

  expect(await dockerAvailable(docker, environment)).toBe(false);
  expect(docker.calls).toEqual([
    {
      args: ["info", "--format", "{{.ServerVersion}}"],
      options: {
        allowFailure: true,
        timeoutMs: 10_000,
        env: { PATH: "/usr/bin:/bin" },
      },
    },
  ]);
  expect(environment).toEqual({
    PATH: "/usr/bin:/bin",
    TOKEN: "sentinel",
    COMPOSE_PROJECT_NAME: "ambient-topology",
    DOCKER_HOST_OVERRIDE: "prefix-must-not-match",
  });
});

it("Docker and Compose environment builders are exact and non-mutating", () => {
  const ambient = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/reviewed",
    DOCKER_HOST: "unix:///reviewed.sock",
    HTTP_PROXY: "http://proxy.invalid",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    LC_ALL: "C.UTF-8",
    COMPOSE_PROJECT_NAME: "ambient-topology",
    DOCKER_HOST_OVERRIDE: "prefix-must-not-match",
    FORWARD: "forward-value",
    PROJECT: "project-value",
    SECRET: "secret-value",
    UNDECLARED: "ambient-value",
  };

  expect(dockerClientEnvironment(ambient)).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/home/reviewed",
    DOCKER_HOST: "unix:///reviewed.sock",
    HTTP_PROXY: "http://proxy.invalid",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    LC_ALL: "C.UTF-8",
  });
  expect(
    composeInvocationEnvironment(
      ["PROJECT", "COMPOSE_PROJECT_NAME"],
      ["FORWARD"],
      ambient,
    ),
  ).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/home/reviewed",
    DOCKER_HOST: "unix:///reviewed.sock",
    HTTP_PROXY: "http://proxy.invalid",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    LC_ALL: "C.UTF-8",
    PROJECT: "project-value",
    FORWARD: "forward-value",
  });
  expect(
    composeUpEnvironment(["PROJECT"], ["FORWARD"], ["SECRET"], ambient),
  ).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/home/reviewed",
    DOCKER_HOST: "unix:///reviewed.sock",
    HTTP_PROXY: "http://proxy.invalid",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    LC_ALL: "C.UTF-8",
    PROJECT: "project-value",
    FORWARD: "forward-value",
    SECRET: "secret-value",
  });
  expect(ambient.COMPOSE_PROJECT_NAME).toBe("ambient-topology");
  expect(ambient.SECRET).toBe("secret-value");
  expect(() =>
    composeUpEnvironment([], [], ["COMPOSE_FILE"], {
      COMPOSE_FILE: "/ambient/compose.yaml",
    }),
  ).toThrow("reserved Compose environment variable: COMPOSE_FILE");
  expect(() =>
    composeUpEnvironment([], [], ["HOME"], { HOME: "/ambient/home" }),
  ).toThrow("conflicts with a non-secret Docker capability: HOME");
  const prototypeAmbient: NodeJS.ProcessEnv = {};
  Object.defineProperty(prototypeAmbient, "__proto__", {
    enumerable: true,
    value: "ordinary-environment-value",
  });
  const prototypeResult = composeInvocationEnvironment(
    ["__proto__"],
    [],
    prototypeAmbient,
  );
  expect(Object.hasOwn(prototypeResult, "__proto__")).toBe(true);
  expect(prototypeResult["__proto__"]).toBe("ordinary-environment-value");
  expect(Object.getPrototypeOf(prototypeResult)).toBe(Object.prototype);
});

it("Compose transport preserves exact arguments and bounded execution options", async () => {
  const docker = new RecordingDocker();
  const controller = new AbortController();
  await composeCommand(
    dockerRuntime(),
    ["ps", "--format", "json"],
    { timeoutMs: 20_000, allowFailure: true, signal: controller.signal },
    docker,
  );

  expect(docker.calls[0]?.args).toEqual([
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
    "ps",
    "--format",
    "json",
  ]);
  expect(docker.calls[0]?.options).toMatchObject({
    timeoutMs: 20_000,
    allowFailure: true,
    maxOutputBytes: 4 * 1024 * 1024,
    signal: controller.signal,
  });
});

it("persisted runtime hydration retains metadata and rejects absent runtime", () => {
  const missing = dockerLab();
  expect(() => runtimeFromLab(missing)).toThrow(
    "lab runtime is unavailable: lab-1",
  );

  const persisted = dockerRuntime().metadata;
  persisted.runtime = {
    config: dockerRuntime().config,
    composeArgs: ["compose", "example"],
    overrideFile: "/tmp/runtime/override.compose.yaml",
    findings: [],
  };
  expect(runtimeFromLab(persisted)).toMatchObject({
    metadata: persisted,
    composeArgs: ["compose", "example"],
  });
});

it("malformed Compose JSON stays inside the fixed redaction boundary", async () => {
  const sentinel = "sentinel-yaml-source-5ea61a";
  const docker = new RecordingDocker();
  docker.responses.push(commandResult(`{"services":"${sentinel}"`));

  const error = await captureError(
    stackLogs(dockerRuntime(), "dev", 10, docker),
  );

  expect(error.message).toBe(
    "Docker Compose configuration failed; secret-bearing diagnostics redacted",
  );
  expect(error.message).not.toContain(sentinel);
  expect(docker.calls).toHaveLength(1);
});

it("null and wrong-shape normalized output stay inside the fixed redaction boundary", async () => {
  const sentinel = "sentinel-wrong-shape-a1c70b";
  for (const output of ["null", "[]", `{"services":"${sentinel}"}`]) {
    const docker = new RecordingDocker();
    docker.responses.push(commandResult(output));

    const error = await captureError(
      stackLogs(dockerRuntime(), "dev", 10, docker),
    );

    expect(error.message).toBe(
      "Docker Compose configuration failed; secret-bearing diagnostics redacted",
    );
    expect(error.message).not.toContain(sentinel);
  }
});

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
