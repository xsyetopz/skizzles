// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { expect, test } from "bun:test";
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

test("Docker availability uses the bounded probe and strips configured secrets", async () => {
  const docker = new RecordingDocker();
  docker.responses.push(commandResult("", 1));
  const environment = { PATH: "/usr/bin:/bin", TOKEN: "sentinel" };

  expect(await dockerAvailable(docker, ["TOKEN"], environment)).toBe(false);
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
  expect(environment).toEqual({ PATH: "/usr/bin:/bin", TOKEN: "sentinel" });
});

test("Compose transport preserves exact arguments and bounded execution options", async () => {
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
    "--project-name",
    "ccl-project",
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

test("persisted runtime hydration retains metadata and rejects absent runtime", () => {
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

test("malformed secret-bearing YAML fallback stays inside the fixed redaction boundary", async () => {
  const sentinel = "sentinel-yaml-source-5ea61a";
  const docker = new RecordingDocker();
  docker.responses.push(
    commandResult("not-json"),
    commandResult(`services:\n  dev:\n    environment: [${sentinel}\n`),
  );

  const error = await captureError(
    stackLogs(dockerRuntime(), "dev", 10, docker),
  );

  expect(error.message).toBe(
    "Docker Compose configuration failed; secret-bearing diagnostics redacted",
  );
  expect(error.message).not.toContain(sentinel);
  expect(docker.calls).toHaveLength(2);
});

test("null and wrong-shape normalized output stay inside the fixed redaction boundary", async () => {
  const sentinel = "sentinel-wrong-shape-a1c70b";
  for (const output of ["null", "[]", `{"services":"${sentinel}"}`]) {
    const docker = new RecordingDocker();
    docker.responses.push(commandResult(output), commandResult(output));

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
