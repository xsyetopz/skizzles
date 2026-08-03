import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVISIONING_FAILURE_DIAGNOSTIC_FILE } from "../compose/runtime";
import { runCommand } from "../execution/process";
import { readLab } from "../storage/state";
import { ContainerLabWorkflow } from "./workflow";
import { ComposeFailureServiceDocker, ServiceLogsDocker } from "./workflow-test-fixtures";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("failed Compose diagnostic service security", () => {
  test("captures unhealthy manifest services even with a zero or absent exit code", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-unhealthy-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
  worker: { service: worker, target: 8081 }
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([
      { Service: "dev", State: "running", Health: "healthy", ExitCode: 0 },
      { Service: "api", State: "running", Health: "unhealthy", ExitCode: 0 },
      { Service: "worker", State: "running", Health: "unhealthy" },
    ], {
      api: "UNHEALTHY_ZERO_EXIT_MARKER",
      worker: "UNHEALTHY_MISSING_EXIT_MARKER",
    }, ["dev", "api", "worker"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-unhealthy", roots, docker);

    const created = await service.createLab("service-unhealthy", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-unhealthy", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain("UNHEALTHY_ZERO_EXIT_MARKER");
    expect(artifact).toContain("UNHEALTHY_MISSING_EXIT_MARKER");
    expect(docker.runCalls.filter((call) => call.args.includes("logs")).map((call) => call.args.at(-1))).toEqual(["api", "worker"]);
    await service.destroyLab(created.labId);
  });

  test("selects a manifest service when any duplicate status row is terminally failed", async () => {
    const scenarios = [
      {
        name: "failing-first",
        statuses: [
          { Service: "dev", State: "exited", ExitCode: 17 },
          { Service: "dev", State: "running", Health: "healthy", ExitCode: 0 },
        ],
        marker: "DUPLICATE_FAILING_FIRST_MARKER",
      },
      {
        name: "healthy-first",
        statuses: [
          { Service: "dev", State: "running", Health: "healthy", ExitCode: 0 },
          { Service: "dev", State: "exited", ExitCode: 17 },
        ],
        marker: "DUPLICATE_HEALTHY_FIRST_MARKER",
      },
    ];
    for (const scenario of scenarios) {
      const root = await mkdtemp(join(tmpdir(), `container-lab-service-log-${scenario.name}-`));
      temporary.push(root);
      const source = join(root, "source");
      await runCommand("git", ["init", source]);
      await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
      await runCommand("git", ["-C", source, "add", "."]);
      await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
      const docker = new ServiceLogsDocker(scenario.statuses, { dev: scenario.marker });
      const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
      const owner = `thread-service-log-${scenario.name}`;
      const service = new ContainerLabWorkflow(owner, roots, docker);

      const created = await service.createLab(`service-${scenario.name}`, source);
      expect(created.state).toBe("failed");
      const lab = await readLab(roots, owner, created.labId);
      const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
      expect(artifact).toContain(scenario.marker);
      expect(docker.runCalls.filter((call) => call.args.includes("logs")).map((call) => call.args.at(-1))).toEqual(["dev"]);
      await service.destroyLab(created.labId);
    }
  });

  test("selects command and declared port services in manifest order beyond public summary limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-order-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
  worker: { service: worker, target: 8081 }
  jobs: { service: jobs, target: 8082 }
  metrics: { service: metrics, target: 8083 }
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const sidecars = Array.from({ length: 16 }, (_, index) => ({ Service: `sidecar-${index}`, State: "exited", ExitCode: 17 }));
    const candidates = ["dev", "api", "worker", "jobs", "metrics"];
    const statuses = [...sidecars, ...candidates.map((Service) => ({ Service, State: "exited", ExitCode: 17 }))];
    const logs = Object.fromEntries(candidates.map((service) => [service, `TERMINAL_${service.toUpperCase()}_MARKER`])) as Record<string, string>;
    const docker = new ServiceLogsDocker(statuses, logs, ["dev", "api", "worker", "jobs", "metrics", ...sidecars.map((row) => row.Service)]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-order", roots, docker);

    const created = await service.createLab("service-order", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-order", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(docker.runCalls.filter((call) => call.args.includes("logs")).map((call) => call.args.at(-1))).toEqual(["dev", "api", "worker", "jobs"]);
    for (const serviceName of ["dev", "api", "worker", "jobs"]) expect(artifact).toContain(`TERMINAL_${serviceName.toUpperCase()}_MARKER`);
    expect(artifact).not.toContain("TERMINAL_METRICS_MARKER");
    expect(lab.provisioningFailure?.serviceCount).toBe(21);
    expect(JSON.stringify(await service.labStatus(created.labId))).not.toContain("TERMINAL_API_MARKER");
    await service.destroyLab(created.labId);
  });

  test("fairly preserves terminal markers for every selected service within the aggregate cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-fairness-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
  worker: { service: worker, target: 8081 }
  jobs: { service: jobs, target: 8082 }
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const selected = ["dev", "api", "worker", "jobs"];
    const statuses = selected.map((Service) => ({ Service, State: "exited", ExitCode: 17 }));
    const logs = Object.fromEntries(selected.map((serviceName) => [
      serviceName,
      `${"NOISY_${serviceName}_PREFIX\\n".repeat(400)}TERMINAL_${serviceName.toUpperCase()}_MARKER`,
    ])) as Record<string, string>;
    const docker = new ServiceLogsDocker(statuses, logs, selected);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-fairness", roots, docker);

    const created = await service.createLab("service-fairness", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-fairness", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    for (const serviceName of selected) expect(artifact).toContain(`TERMINAL_${serviceName.toUpperCase()}_MARKER`);
    expect(Buffer.byteLength(artifact)).toBeLessThanOrEqual(8 * 1024);
    expect(artifact.split("\n").length).toBeLessThanOrEqual(500);
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, truncated: true });
    for (const call of docker.runCalls.filter((entry) => entry.args.includes("logs"))) {
      expect(call.options).toMatchObject({ stdoutCapture: "tail", stderrCapture: "tail" });
    }
    await service.destroyLab(created.labId);
  });

  test("allocates equal service log stream caps without trimming either terminal stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-stream-cap-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const stdoutMarker = "STDOUT_TERMINAL_MARKER";
    const stderrMarker = "STDERR_TERMINAL_MARKER";
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: (options) => {
        const streamBytes = options?.maxOutputBytes ?? 0;
        const stream = (marker: string) => {
          const markerBytes = Buffer.from(marker);
          return Buffer.concat([markerBytes, Buffer.alloc(Math.max(0, streamBytes - markerBytes.byteLength), "x")]);
        };
        return { code: 0, stdout: stream(stdoutMarker), stderr: stream(stderrMarker) };
      },
    });
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-stream-cap", roots, docker);

    const created = await service.createLab("service-stream-cap", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-stream-cap", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain(stdoutMarker);
    expect(artifact).toContain(stderrMarker);
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, truncated: false });
    await service.destroyLab(created.labId);
  });

  test("fails closed across service log secrets, paths, and control bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-redaction-"));
    temporary.push(root);
    const source = join(root, "source");
    const secret = "service-log-secret-8f31";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const statuses = [{ Service: "dev", State: "exited", ExitCode: 17 }];
    const docker = new ServiceLogsDocker(statuses, {
      dev: `secret=${secret} path=/private/tmp/adversarial windows=C:\\Users\\adversarial\\AppData\\Local\\Docker\\secret unc=\\\\server\\share\\secret project=ccl-private id=${"a".repeat(64)}\u0001`,
    });
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-redaction", roots, docker, {
      PATH: process.env.PATH,
      REGISTRY_TOKEN: secret,
    });

    const created = await service.createLab("service-redaction", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-redaction", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    const status = JSON.stringify(await service.labStatus(created.labId));
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    const logsCall = docker.runCalls.find((call) => call.args.includes("logs"));
    expect(logsCall).toBeDefined();
    expect(logsCall?.options?.env?.REGISTRY_TOKEN).toBeUndefined();
    for (const value of [artifact, status, diagnostic]) {
      expect(value).not.toContain(secret);
      expect(value).not.toContain("/private/tmp");
      expect(value).not.toContain("C:\\Users\\adversarial\\AppData\\Local\\Docker\\secret");
      expect(value).not.toContain("\\\\server\\share\\secret");
      expect(value).not.toContain("ccl-private");
      expect(value).not.toContain("a".repeat(64));
      expect(value).not.toContain("\u0001");
    }
    expect(Buffer.byteLength(artifact)).toBeLessThanOrEqual(8 * 1024);
    await service.destroyLab(created.labId);
  });

  test("keeps the fixed Compose error when selected service log capture fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-failure-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], { dev: new Error("logs unavailable") });
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabWorkflow("thread-service-log-failure", roots, docker);

    const created = await service.createLab("service-log-failure", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-failure", created.labId);
    expect(lab.error).toBe("Docker Compose up failed; secret-bearing diagnostics redacted");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, truncated: true });
    await service.destroyLab(created.labId);
  });

  test("omits an out-of-contract Compose exit code without masking the original failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-failed-exit-code-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new ComposeFailureServiceDocker("sentinel-invalid-exit", 999);
    const service = new ContainerLabWorkflow("thread-invalid-exit", roots, docker, { PATH: process.env.PATH });

    const created = await service.createLab("invalid-exit", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-invalid-exit", created.labId);
    expect(lab.error).toBe("Docker Compose up failed; secret-bearing diagnostics redacted");
    expect(lab.provisioningFailure?.services).toEqual([{ service: "dev", state: "exited", health: "unhealthy" }]);
    await service.destroyLab(created.labId);
  });

  test("replaces overlapping secret values longest-first across all diagnostic surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-overlap-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    const short = "token";
    const long = "token-private-suffix";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [TOKEN_SHORT, TOKEN_LONG]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new ComposeFailureServiceDocker(long);
    const service = new ContainerLabWorkflow("thread-overlap-secret", roots, docker, {
      PATH: process.env.PATH,
      TOKEN_SHORT: short,
      TOKEN_LONG: long,
    });

    const created = await service.createLab("overlap-secret", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-overlap-secret", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    const status = JSON.stringify(await service.labStatus(created.labId));
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    for (const value of [short, long, "private-suffix"]) {
      expect(artifact).not.toContain(value);
      expect(status).not.toContain(value);
      expect(diagnostic).not.toContain(value);
    }
    await service.destroyLab(created.labId);
  });

  test("falls back to an empty transcript when a secret collides with the replacement marker", async () => {
    for (const [secret, name] of [["secret", "TOKEN_SECRET"], ["[secret-value-redacted]", "TOKEN_MARKER"]] as const) {
      const root = await mkdtemp(join(tmpdir(), "container-lab-marker-secret-"));
      temporary.push(root);
      const source = join(root, "source");
      await runCommand("git", ["init", source]);
      await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }\nsecret_environment: [${name}]\n`);
      await runCommand("git", ["-C", source, "add", "."]);
      await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
      const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
      const docker = new ComposeFailureServiceDocker(secret);
      const service = new ContainerLabWorkflow(`thread-marker-${name.toLowerCase()}`, roots, docker, {
        PATH: process.env.PATH,
        [name]: secret,
      });

      const created = await service.createLab("marker-secret", source);
      expect(created.state).toBe("failed");
      const lab = await readLab(roots, `thread-marker-${name.toLowerCase()}`, created.labId);
      expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0, truncated: false });
      const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
      expect(artifact).toBe("");

      const status = JSON.stringify(await service.labStatus(created.labId));
      expect(status).toContain('"bytes":0');
      expect(status).toContain('"lines":0');
      expect(status).not.toContain("[secret-value-redacted]");
      const diagnostic = await service.diagnostic(created.labId) as { diagnostic: { transcript: { text: string } } };
      expect(diagnostic.diagnostic.transcript.text).toBe("");
      expect(JSON.stringify(diagnostic.diagnostic.transcript)).not.toContain(secret);
      await service.destroyLab(created.labId);
    }
  });

  test("falls back to an empty transcript when sanitization introduces a declared secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-sanitized-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    const secret = "�";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [TOKEN_REPLACEMENT]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new ComposeFailureServiceDocker(secret, 23, "Compose failed \u0001");
    const service = new ContainerLabWorkflow("thread-sanitized-secret", roots, docker, {
      PATH: process.env.PATH,
      TOKEN_REPLACEMENT: secret,
    });

    const created = await service.createLab("sanitized", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-sanitized-secret", created.labId);
    expect(lab.error).toBe("Docker Compose up failed; secret-bearing diagnostics redacted");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0, truncated: false });
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toBe("");

    const status = JSON.stringify(await service.labStatus(created.labId));
    expect(status).toContain('"bytes":0');
    expect(status).toContain('"lines":0');
    expect(status).not.toContain(secret);
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    expect(diagnostic).toContain('"text":""');
    expect(diagnostic).not.toContain(secret);
    await service.destroyLab(created.labId);
  });

});
