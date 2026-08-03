import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLabRuntime, DockerProvisioningFailure, PROVISIONING_FAILURE_DIAGNOSTIC_FILE, provisionLabStack } from "./runtime";
import { parseLabConfig } from "./config";
import { cleanupLabLabels } from "./cleanup";
import { launchDockerRun } from "./attached";
import { ComposeFailureDocker, SecretRecordingDocker, labAt } from "./runtime-test-fixtures";

describe("secret environment materialization", () => {
  test("keeps values ephemeral and sends them only to Compose config and up", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-"));
    const sentinel = "sentinel-registry-token-8fca7b";
    try {
      const docker = new SecretRecordingDocker(sentinel);
      const config = parseLabConfig(`
image: { name: node:24, service: dev }
environment: [TERM]
secret_environment: [REGISTRY_TOKEN]
`, join(root, "source"));
      const metadata = labAt(root);
      metadata.secretEnvironment = ["REGISTRY_TOKEN"];
      const environment = { PATH: "/usr/bin:/bin", TERM: "xterm", REGISTRY_TOKEN: sentinel };
      const prepared = await prepareLabRuntime(metadata, config, docker, environment);
      await provisionLabStack(prepared, undefined, docker, environment);
      launchDockerRun(prepared, {
        runId: "11111111-1111-4111-8111-111111111111",
        cwd: ".",
        argv: ["true"],
        environment: {},
      }, docker, environment);
      await cleanupLabLabels(metadata, false, docker, environment);

      const durable = JSON.stringify({ metadata, runtime: prepared, findings: prepared.findings });
      expect(durable).not.toContain(sentinel);
      expect(prepared.findings.some((finding) => finding.surface === "secret")).toBe(true);
      expect(JSON.stringify(prepared.findings)).not.toContain("REGISTRY_TOKEN");
      expect(prepared.composeArgs.join("\0")).not.toContain(sentinel);
      expect(await readFile(prepared.baseFile!, "utf8")).not.toContain(sentinel);
      expect(await readFile(prepared.overrideFile, "utf8")).not.toContain(sentinel);

      const carryingSecret = docker.calls.filter((call) => call.options?.env?.REGISTRY_TOKEN === sentinel);
      expect(carryingSecret.length).toBeGreaterThanOrEqual(3);
      expect(carryingSecret.every((call) => call.args.includes("config") || call.args.includes("up"))).toBe(true);
      for (const call of docker.calls.filter((call) => !call.args.includes("config") && !call.args.includes("up"))) {
        expect(Object.hasOwn(call.options?.env ?? {}, "REGISTRY_TOKEN")).toBe(false);
      }
      expect(docker.spawnCalls).toHaveLength(1);
      expect(Object.hasOwn(docker.spawnCalls[0]!.options?.env ?? {}, "REGISTRY_TOKEN")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces secret-bearing Compose config and up diagnostics with fixed errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-error-"));
    const sentinel = "sentinel-error-token-290ea1";
    try {
      const config = parseLabConfig("image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n", join(root, "source"));
      const environment = { PATH: "/usr/bin:/bin", REGISTRY_TOKEN: sentinel };
      const configFailure = new SecretRecordingDocker(sentinel);
      configFailure.failConfig = true;
      let configError: unknown;
      try { await prepareLabRuntime(labAt(root), config, configFailure, environment); }
      catch (error) { configError = error; }
      expect(configError).toBeInstanceOf(Error);
      expect((configError as Error).message).toBe("Docker Compose configuration failed; secret-bearing diagnostics redacted");
      expect((configError as Error).message).not.toContain(sentinel);

      const upFailure = new SecretRecordingDocker(sentinel);
      const prepared = await prepareLabRuntime(labAt(root), config, upFailure, environment);
      upFailure.failUp = true;
      let upError: unknown;
      try { await provisionLabStack(prepared, undefined, upFailure, environment); }
      catch (error) { upError = error; }
      expect(upError).toBeInstanceOf(Error);
      expect((upError as Error).message).toBe("Docker Compose up failed; secret-bearing diagnostics redacted");
      expect((upError as Error).message).not.toContain(sentinel);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("failed Compose diagnostics", () => {
  test("captures --all service exits before cleanup and writes only bounded owner-scoped evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-compose-failure-"));
    const sentinel = "sentinel-compose-secret-4f17";
    try {
      const config = parseLabConfig("image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n", join(root, "source"));
      const environment = { PATH: "/usr/bin:/bin", REGISTRY_TOKEN: sentinel };
      const docker = new ComposeFailureDocker(sentinel, JSON.stringify([
        { Service: "dev", State: "exited", Health: "unhealthy", ExitCode: 17, ID: "container-private", Project: "ccl-private" },
      ]));
      const prepared = await prepareLabRuntime(labAt(root), config, docker, environment);
      let failure: unknown;
      try { await provisionLabStack(prepared, undefined, docker, environment); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(DockerProvisioningFailure);
      const diagnostic = (failure as DockerProvisioningFailure).diagnostic;
      expect(diagnostic.phase).toBe("compose-up");
      expect(diagnostic.services).toEqual([{ service: "dev", state: "exited", health: "unhealthy", exitCode: 17 }]);
      expect(diagnostic.evidence?.available).toBe(true);
      const up = docker.calls.findIndex((args) => args.includes("up"));
      const ps = docker.calls.findIndex((args) => args.includes("ps") && args.includes("--all"));
      expect(ps).toBeGreaterThan(up);
      const artifact = join(labAt(root).runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE);
      const info = await lstat(artifact);
      expect(info.isFile()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.mode & 0o777).toBe(0o600);
      const text = await readFile(artifact, "utf8");
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain("/private/tmp");
      expect(text).not.toContain("ccl-private");
      expect(text).not.toContain("a".repeat(64));
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("capture failure preserves the fixed Compose error", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-compose-failure-write-"));
    try {
      const config = parseLabConfig("image: { name: node:24, service: dev }\n", join(root, "source"));
      const docker = new ComposeFailureDocker("unused", "not-json");
      const prepared = await prepareLabRuntime(labAt(root), config, docker);
      await rm(prepared.metadata.runtimeRoot, { recursive: true, force: true });
      await expect(provisionLabStack(prepared, undefined, docker)).rejects.toThrow(
        "Docker Compose up failed; secret-bearing diagnostics redacted",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
