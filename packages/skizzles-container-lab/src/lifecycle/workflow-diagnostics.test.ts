import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVISIONING_FAILURE_DIAGNOSTIC_FILE } from "../compose/runtime";
import { runCommand } from "../execution/process";
import { readLab } from "../storage/state";
import { ContainerLabWorkflow } from "./workflow";
import { ComposeFailureServiceDocker, LargeComposeFailureServiceDocker, ServiceLogsDocker } from "./workflow-test-fixtures";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("failed Compose diagnostics", () => {
  test("persists failed Compose evidence, serves it across service instances, and removes it on destroy", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-failed-diagnostic-"));
    temporary.push(root);
    const source = join(root, "source");
    const sentinel = "sentinel-failed-compose-7b22";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new ComposeFailureServiceDocker(sentinel);
    const service = new ContainerLabWorkflow("thread-failed-diagnostic", roots, docker, {
      PATH: process.env.PATH,
      REGISTRY_TOKEN: sentinel,
    });

    const created = await service.createLab("failed", source);
    expect(Object.keys(created).sort()).toEqual(["labId", "state"]);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-failed-diagnostic", created.labId);
    expect(lab.provisioningFailure).toMatchObject({
      phase: "compose-up",
      services: [{ service: "dev", state: "exited", health: "unhealthy", exitCode: 23 }],
    });
    const status = JSON.stringify(await service.labStatus(created.labId));
    expect(status).toContain("provisioningFailure");
    expect(status).toContain("exited");
    for (const forbidden of [sentinel, "/private/tmp", "ccl-private", "private-container-id", lab.ownerKey, lab.runtimeRoot]) {
      expect(status).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(status)).toBeLessThanOrEqual(16 * 1024);
    const artifact = join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE);
    expect(lab.provisioningFailure?.evidence?.available).toBe(true);
    expect(await Bun.file(artifact).exists()).toBe(true);

    const fresh = new ContainerLabWorkflow("thread-failed-diagnostic", roots, docker, { PATH: process.env.PATH });
    const diagnostic = JSON.stringify(await fresh.diagnostic(created.labId));
    expect(diagnostic).toContain('"phase":"compose-up"');
    expect(diagnostic).toContain("exited");
    expect(diagnostic).not.toContain(sentinel);
    expect(diagnostic).not.toContain("/private/tmp");
    expect(diagnostic).not.toContain(lab.runtimeRoot);
    expect(diagnostic).not.toContain(PROVISIONING_FAILURE_DIAGNOSTIC_FILE);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(16 * 1024);

    await expect(new ContainerLabWorkflow("another-owner", roots, docker).diagnostic(created.labId)).rejects.toThrow();
    expect((await fresh.destroyLab(created.labId)).destroyed).toBe(true);
    expect(await Bun.file(artifact).exists()).toBe(false);
    await expect(readLab(roots, "thread-failed-diagnostic", created.labId)).rejects.toThrow();
  });

  test("retains terminal Compose failure lines after the upstream output cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-terminal-diagnostic-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new LargeComposeFailureServiceDocker();
    const service = new ContainerLabWorkflow("thread-terminal-diagnostic", roots, docker, { PATH: process.env.PATH });

    const created = await service.createLab("terminal", source);
    expect(created.state).toBe("failed");
    const up = docker.runCalls.find((call) => call.args.includes("up"));
    expect(up?.options).toMatchObject({
      maxOutputBytes: 4 * 1024 * 1024,
      stdoutCapture: "tail",
      stderrCapture: "tail",
    });
    const lab = await readLab(roots, "thread-terminal-diagnostic", created.labId);
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, truncated: true });
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain("TERMINAL_DEV_EXIT_17");
    expect(artifact).toContain("TERMINAL_COMPOSE_FAILURE_DEV");
    expect(Buffer.byteLength(artifact)).toBeLessThanOrEqual(8 * 1024);
    expect(artifact.split("\n").length).toBeLessThanOrEqual(500);

    const status = JSON.stringify(await service.labStatus(created.labId));
    expect(status).toContain('"truncated":true');
    expect(status).not.toContain(lab.runtimeRoot);
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    expect(diagnostic).toContain("TERMINAL_COMPOSE_FAILURE_DEV");
    expect(diagnostic).toContain("TERMINAL_DEV_EXIT_17");
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(16 * 1024);
    await service.destroyLab(created.labId);
  });

  test("combines lifecycle and failed-service logs while excluding healthy, exit-zero, and unexposed services", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-selection-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const statuses = [
      { Service: "dev", State: "exited", ExitCode: 17 },
      { Service: "api", State: "running", Health: "healthy", ExitCode: 0 },
      { Service: "exit-zero", State: "exited", ExitCode: 0 },
      { Service: "database", State: "exited", ExitCode: 17 },
    ];
    const docker = new ServiceLogsDocker(statuses, {
      dev: "MIGRATION_ERROR_MARKER",
      api: "HEALTHY_SERVICE_MARKER",
      database: "UNEXPOSED_SIDECAR_MARKER",
    }, ["dev", "api"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-selection", roots, docker);

    const created = await service.createLab("service-logs", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-selection", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain("--- compose-up ---");
    expect(artifact).toContain("LIFECYCLE_MARKER");
    expect(artifact).toContain("--- service:dev ---");
    expect(artifact).toContain("MIGRATION_ERROR_MARKER");
    expect(artifact).not.toContain("HEALTHY_SERVICE_MARKER");
    expect(artifact).not.toContain("UNEXPOSED_SIDECAR_MARKER");
    const logsCalls = docker.runCalls.filter((call) => call.args.includes("logs"));
    expect(logsCalls.map((call) => call.args.at(-1))).toEqual(["dev"]);
    const logsArgs = logsCalls[0]!.args;
    const logsIndex = logsArgs.indexOf("logs");
    expect(logsArgs.slice(logsIndex)).toEqual(["logs", "--no-color", "--no-log-prefix", "--tail", "374", "dev"]);
    expect(lab.provisioningFailure?.services).toEqual([
      { service: "dev", state: "exited", exitCode: 17 },
      { service: "api", state: "running", health: "healthy", exitCode: 0 },
      { service: "exit-zero", state: "exited", exitCode: 0 },
      { service: "database", state: "exited", exitCode: 17 },
    ]);
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    expect(diagnostic).toContain("MIGRATION_ERROR_MARKER");
    expect(diagnostic).not.toContain("HEALTHY_SERVICE_MARKER");
    await service.destroyLab(created.labId);
  });

  test("keeps safe service evidence when a secret equals the trusted service name", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-header-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [LAB_SECRET]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: "SAFE_BODY_MARKER",
    }, ["dev"], "SAFE_LIFECYCLE_MARKER");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-header-secret", roots, docker, {
      PATH: process.env.PATH,
      LAB_SECRET: "dev",
    });

    const created = await service.createLab("header-secret", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-header-secret", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain("--- service:dev ---");
    expect(artifact).toContain("SAFE_BODY_MARKER");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: expect.any(Number) });
    await service.destroyLab(created.labId);
  });

  test("redacts a service-body secret without treating its trusted header as a leak", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-body-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [LAB_SECRET]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: "BODY_dev_MARKER",
    }, ["dev"], "SAFE_LIFECYCLE_MARKER");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-body-secret", roots, docker, {
      PATH: process.env.PATH,
      LAB_SECRET: "dev",
    });

    const created = await service.createLab("body-secret", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-body-secret", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    const body = artifact.slice(artifact.indexOf("--- service:dev ---") + "--- service:dev ---".length);
    expect(artifact).toContain("--- service:dev ---");
    expect(artifact).toContain("[secret-value-redacted]");
    expect(body).not.toContain("dev");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true });
    await service.destroyLab(created.labId);
  });

  test("erases the artifact when service-body control sanitization recreates a declared secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-control-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [TOKEN_REPLACEMENT]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: "\u0001",
    }, ["dev"], "SAFE_LIFECYCLE_MARKER");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-control-secret", roots, docker, {
      PATH: process.env.PATH,
      TOKEN_REPLACEMENT: "�",
    });

    const created = await service.createLab("control-secret", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-control-secret", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toBe("");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0 });
    await service.destroyLab(created.labId);
  });

  test("checks body and framing provenance for boundary, one-character, and newline secrets", async () => {
    const scenarios = [
      { name: "one-character-frame", secret: "d", body: "SAFE_BODY_MARKER", empty: false },
      { name: "newline-frame", secret: "\n", body: "SAFE_BODY_MARKER", empty: false },
      { name: "one-character-body", secret: "d", body: "BODY_d_MARKER", empty: true },
      { name: "newline-body", secret: "\n", body: "BODY\nMARKER", empty: false },
      { name: "mixed-boundary", secret: "-\nS", body: "SAFE_BODY_MARKER", empty: true },
    ];
    for (const scenario of scenarios) {
      const root = await mkdtemp(join(tmpdir(), `container-lab-service-log-${scenario.name}-`));
      temporary.push(root);
      const source = join(root, "source");
      await runCommand("git", ["init", source]);
      await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [LAB_SECRET]\n");
      await runCommand("git", ["-C", source, "add", "."]);
      await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
      const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
        dev: scenario.body,
      }, ["dev"], "SAFE_LIFECYCLE_MARKER");
      const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
      const owner = `thread-service-log-${scenario.name}`;
      const service = new ContainerLabWorkflow(owner, roots, docker, {
        PATH: process.env.PATH,
        LAB_SECRET: scenario.secret,
      });

      const created = await service.createLab(`service-${scenario.name}`, source);
      expect(created.state).toBe("failed");
      const lab = await readLab(roots, owner, created.labId);
      const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
      if (scenario.empty) {
        expect(artifact).toBe("");
        expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0 });
      } else {
        const header = "--- service:dev ---";
        expect(artifact).toContain(header);
        const body = artifact.slice(artifact.indexOf(header) + header.length).replace(/^\n/, "");
        expect(body).not.toContain(scenario.secret);
      }
      await service.destroyLab(created.labId);
    }
  });

  test("erases a secret reconstructed from lifecycle body into service framing", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-lifecycle-boundary-"));
    temporary.push(root);
    const source = join(root, "source");
    const secret = "END\n--- service:dev ---";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [LAB_SECRET]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: "SAFE_SERVICE_MARKER",
    }, ["dev"], "END");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-lifecycle-boundary", roots, docker, {
      PATH: process.env.PATH,
      LAB_SECRET: secret,
    });

    const created = await service.createLab("lifecycle-boundary", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-lifecycle-boundary", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toBe("");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0 });
    await service.destroyLab(created.labId);
  });

  test("erases a secret reconstructed from one service body into the next service framing", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-service-boundary-"));
    temporary.push(root);
    const source = join(root, "source");
    const secret = "END\n--- service:api ---";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
secret_environment: [LAB_SECRET]
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([
      { Service: "dev", State: "exited", ExitCode: 17 },
      { Service: "api", State: "exited", ExitCode: 23 },
    ], {
      dev: "END",
      api: "SAFE_API_MARKER",
    }, ["dev", "api"], "SAFE_LIFECYCLE_MARKER");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-service-boundary", roots, docker, {
      PATH: process.env.PATH,
      LAB_SECRET: secret,
    });

    const created = await service.createLab("service-boundary", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-service-boundary", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toBe("");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0 });
    await service.destroyLab(created.labId);
  });

});
