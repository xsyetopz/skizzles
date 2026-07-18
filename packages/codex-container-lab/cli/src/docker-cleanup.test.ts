import { expect, test } from "bun:test";
import { cleanupLabLabels } from "./docker.ts";
import {
  commandResult,
  dockerLab,
  RecordingDocker,
} from "./docker-test-support.ts";

test("cleanup strips secret material from every Docker operation without mutating caller input", async () => {
  const docker = new RecordingDocker();
  const metadata = dockerLab({ secretEnvironment: ["TOKEN"] });
  const environment = { PATH: "/usr/bin:/bin", TOKEN: "sentinel" };

  await cleanupLabLabels(metadata, false, docker, environment);

  expect(docker.calls).toHaveLength(6);
  for (const call of docker.calls) {
    expect(call.options?.env).toEqual({ PATH: "/usr/bin:/bin" });
  }
  expect(environment).toEqual({ PATH: "/usr/bin:/bin", TOKEN: "sentinel" });
});

test("cleanup confirms exact resources are absent after each removal phase", async () => {
  const docker = new RecordingDocker();
  docker.responses.push(commandResult(""), commandResult("container-left\n"));

  await expect(cleanupLabLabels(dockerLab(), false, docker)).rejects.toThrow(
    "managed lab containers remain after cleanup",
  );
  expect(docker.calls.some((call) => call.args.includes("rm"))).toBe(false);
});

test("cleanup rejects a successful null ownership inspection with a fixed diagnostic", async () => {
  const docker = new RecordingDocker();
  docker.responses.push(
    commandResult(""),
    commandResult(""),
    commandResult("volume-id\n"),
    commandResult("null"),
  );

  await expect(cleanupLabLabels(dockerLab(), false, docker)).rejects.toThrow(
    "invalid managed volume ownership labels",
  );
  expect(docker.calls.some((call) => call.args.includes("rm"))).toBe(false);
});
