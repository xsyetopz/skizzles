// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, test } from "bun:test";
import {
  ContainerLabService,
  durableFixture,
  InterruptingDocker,
  join,
  labManifestPath,
  mkdtemp,
  process,
  RecordingDocker,
  readFileSync,
  readLab,
  runCommand,
  SecretDiagnosticDocker,
  temporary,
  tmpdir,
  writeFile,
  writeFileSync,
  writeLab,
} from "./service-test-support.ts";

describe("service provisioning", () => {
  test("create provisions synchronously and returns only lab identity and terminal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-create-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "image: { name: node:24, service: dev }\n",
    );
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    ]);
    const roots = {
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
    };
    const result = await new ContainerLabService(
      "thread-create",
      roots,
      new RecordingDocker(),
    ).createLab("experiment", source);
    expect(Object.keys(result).sort()).toEqual(["labId", "state"]);
    expect(result.state).toBe("ready");
    expect((await readLab(roots, "thread-create", result.labId)).state).toBe(
      "ready",
    );
  });

  test("persists only secret names and never exposes the provisioning value", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-create-"));
    temporary.push(root);
    const source = join(root, "source");
    const sentinel = "sentinel-service-token-c89fd0";
    await runCommand("git", ["init", source]);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n",
    );
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    ]);
    const roots = {
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
    };
    const docker = new RecordingDocker();
    docker.model = {
      services: { dev: {} },
      secrets: { registry: { environment: "REGISTRY_TOKEN" } },
    };
    const service = new ContainerLabService("thread-secret", roots, docker, {
      PATH: process.env["PATH"],
      REGISTRY_TOKEN: sentinel,
    });

    const created = await service.createLab("secret", source);
    expect(created.state).toBe("ready");
    const lab = await readLab(roots, "thread-secret", created.labId);
    expect(lab.secretEnvironment).toEqual(["REGISTRY_TOKEN"]);
    expect(lab.runtime?.config.secretEnvironment).toEqual(["REGISTRY_TOKEN"]);
    expect(JSON.stringify(lab)).not.toContain(sentinel);
    expect(
      readFileSync(labManifestPath(roots.stateRoot, lab.owner, lab.id), "utf8"),
    ).not.toContain(sentinel);
    const runtime = lab.runtime;
    if (!runtime?.baseFile) {
      throw new Error("expected ready runtime files");
    }
    expect(readFileSync(runtime.baseFile, "utf8")).not.toContain(sentinel);
    expect(readFileSync(runtime.overrideFile, "utf8")).not.toContain(sentinel);
    expect(JSON.stringify(await service.labStatus(lab.id))).not.toContain(
      sentinel,
    );

    const carryingSecret = docker.runCalls.filter(
      (call) => call.options?.env?.["REGISTRY_TOKEN"] === sentinel,
    );
    expect(carryingSecret.length).toBeGreaterThanOrEqual(3);
    expect(
      carryingSecret.every(
        (call) => call.args.includes("config") || call.args.includes("up"),
      ),
    ).toBe(true);
    expect(docker.calls.every((args) => !args.includes(sentinel))).toBe(true);
  });

  test("fails before Docker when a declared secret environment value is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-missing-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "image: { name: node:24, service: dev }\nsecret_environment: [MISSING_TOKEN]\n",
    );
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    ]);
    const roots = {
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
    };
    const docker = new RecordingDocker();
    const service = new ContainerLabService(
      "thread-secret-missing",
      roots,
      docker,
      { PATH: process.env["PATH"] },
    );

    const created = await service.createLab("secret", source);
    const lab = await readLab(roots, "thread-secret-missing", created.labId);
    expect(lab.state).toBe("failed");
    expect(lab.secretEnvironment).toEqual(["MISSING_TOKEN"]);
    expect(lab.error).toBe(
      "secret environment variable is unavailable: MISSING_TOKEN",
    );
    expect(docker.calls).toEqual([]);
  });

  test("persists a fixed redacted error when Compose echoes a secret value", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-failure-"));
    temporary.push(root);
    const source = join(root, "source");
    const sentinel = "sentinel-persisted-error-d3c116";
    await runCommand("git", ["init", source]);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n",
    );
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    ]);
    const roots = {
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
    };
    const docker = new SecretDiagnosticDocker(sentinel);
    const service = new ContainerLabService(
      "thread-secret-failure",
      roots,
      docker,
      {
        PATH: process.env["PATH"],
        REGISTRY_TOKEN: sentinel,
      },
    );

    const created = await service.createLab("secret", source);
    const lab = await readLab(roots, "thread-secret-failure", created.labId);
    expect(lab.state).toBe("failed");
    expect(lab.error).toBe(
      "Docker Compose configuration failed; secret-bearing diagnostics redacted",
    );
    expect(JSON.stringify(lab)).not.toContain(sentinel);
    expect(JSON.stringify(await service.labStatus(lab.id))).not.toContain(
      sentinel,
    );
    await service.destroyLab(lab.id);
    for (const call of docker.runCalls.filter(
      (call) => !(call.args.includes("config") || call.args.includes("up")),
    )) {
      expect(Object.hasOwn(call.options?.env ?? {}, "REGISTRY_TOKEN")).toBe(
        false,
      );
    }
  });

  test("health scrubs the union of secret names from known labs", async () => {
    const fixture = await durableFixture(
      "thread-health-secrets",
      "ready",
      true,
    );
    fixture.lab.secretEnvironment = ["REGISTRY_TOKEN"];
    const runtime = fixture.lab.runtime;
    if (!runtime) {
      throw new Error("expected ready runtime");
    }
    runtime.config.secretEnvironment = ["REGISTRY_TOKEN"];
    await writeLab(fixture.roots, fixture.lab);
    const docker = new RecordingDocker();
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      docker,
      {
        PATH: process.env["PATH"],
        REGISTRY_TOKEN: "sentinel-health-token",
      },
    );

    expect((await service.health()).dockerAvailable).toBe(true);
    const info = docker.runCalls.find((call) => call.args[0] === "info");
    expect(info).toBeDefined();
    expect(Object.hasOwn(info?.options?.env ?? {}, "REGISTRY_TOKEN")).toBe(
      false,
    );
  });

  test("loads legacy version-1 ready state without secret metadata for status and destroy", async () => {
    const fixture = await durableFixture("thread-legacy-ready", "ready", true);
    const path = labManifestPath(
      fixture.roots.stateRoot,
      fixture.owner,
      fixture.lab.id,
    );
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.secretEnvironment;
    delete legacy.runtime.config.secretEnvironment;
    writeFileSync(path, JSON.stringify(legacy));
    const docker = new RecordingDocker();
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      docker,
    );

    expect(
      ((await service.labStatus(fixture.lab.id)) as { state: string }).state,
    ).toBe("ready");
    expect(
      (await readLab(fixture.roots, fixture.owner, fixture.lab.id))
        .secretEnvironment,
    ).toEqual([]);
    expect(await service.destroyLab(fixture.lab.id)).toEqual({
      labId: fixture.lab.id,
      destroyed: true,
    });
  });

  test("interrupted synchronous provisioning records a recoverable failed lab", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "container-lab-interrupted-create-"),
    );
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "image: { name: node:24, service: dev }\n",
    );
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    ]);
    const roots = {
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
    };
    const controller = new AbortController();
    const result = await new ContainerLabService(
      "thread-interrupt",
      roots,
      new InterruptingDocker(controller),
    ).createLab("experiment", source, controller.signal);
    expect(result.state).toBe("failed");
    const persisted = await readLab(roots, "thread-interrupt", result.labId);
    expect(persisted.state).toBe("failed");
    expect(persisted.error).toContain("aborted");
  });
});
