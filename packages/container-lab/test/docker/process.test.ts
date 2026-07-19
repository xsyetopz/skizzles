// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { expect, test } from "bun:test";
import { launchDockerRun, terminateDockerRun } from "../../src/docker.ts";
import {
  commandResult,
  dockerLab,
  dockerRuntime,
  RecordingDocker,
} from "./support.ts";

test("attached process transport preserves workdir, argv, and explicit environment ordering", () => {
  const docker = new RecordingDocker();
  const runtime = dockerRuntime(dockerLab({ secretEnvironment: ["TOKEN"] }));
  launchDockerRun(
    runtime,
    {
      runId: "11111111-1111-4111-8111-111111111111",
      cwd: "nested/path",
      argv: ["printf", "%s", "value"],
      environment: { FIRST: "one", SECOND: "two" },
    },
    docker,
    { PATH: "/usr/bin:/bin", TOKEN: "sentinel" },
  );

  const invocation = docker.spawnCalls[0];
  expect(invocation?.args.slice(0, 21)).toEqual([
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
    "exec",
    "-T",
    "--workdir",
    "/workspace/nested/path",
    "--env",
    "FIRST=one",
    "--env",
    "SECOND=two",
    "dev",
    "/bin/sh",
  ]);
  expect(invocation?.args.slice(-4)).toEqual([
    "codex-container-lab-run",
    "printf",
    "%s",
    "value",
  ]);
  expect(invocation?.options?.env).toEqual({ PATH: "/usr/bin:/bin" });
});

test("termination maps unknown or failed Docker transport to unconfirmed states", async () => {
  const unknown = new RecordingDocker();
  unknown.responses.push(commandResult("unexpected transcript\n"));
  await expect(
    terminateDockerRun(dockerRuntime(), { runId: "run-1" }, "TERM", unknown),
  ).resolves.toEqual({ confirmed: false, status: "unavailable" });

  const failed = new RecordingDocker();
  failed.runError = new Error("Docker transport failed");
  await expect(
    terminateDockerRun(dockerRuntime(), { runId: "run-1" }, "TERM", failed),
  ).resolves.toEqual({ confirmed: false, status: "docker-failure" });
});
