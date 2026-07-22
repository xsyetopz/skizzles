import { afterEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import {
  ContainerLabService,
  createLabServiceFixtureScope,
  InterruptingDocker,
  join,
  labManifestPath,
  mkdir,
  mkdtemp,
  process,
  readFileSync,
  readLab,
  RecordingDocker,
  runCommand,
  SecretDiagnosticDocker,
  tmpdir,
  writeFile,
  writeFileSync,
  writeLab,
} from "./support.ts";

const fixtures = createLabServiceFixtureScope();
const { durableFixture, trackTemporaryPath } = fixtures;
afterEach(fixtures.cleanup);

describe("service provisioning", () => {
  test("local clone ignores ambient and repository executable Git configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-git-env-"));
    trackTemporaryPath(root);
    const source = join(root, "source");
    const hooks = join(root, "hooks");
    const hookSentinel = join(root, "ambient-hook-ran");
    const fsmonitorSentinel = join(root, "repository-fsmonitor-ran");
    const fsmonitor = join(root, "fsmonitor");
    await runCommand("git", ["init", source]);
    await mkdir(hooks);
    await writeFile(
      join(hooks, "post-checkout"),
      `#!/bin/sh\nprintf 'unsafe\\n' > ${JSON.stringify(hookSentinel)}\n`,
    );
    await chmod(join(hooks, "post-checkout"), 0o755);
    await writeFile(
      fsmonitor,
      `#!/bin/sh\nprintf 'unsafe\\n' > ${JSON.stringify(fsmonitorSentinel)}\n`,
    );
    await chmod(fsmonitor, 0o755);
    const globalConfig = join(root, "ambient.gitconfig");
    await writeFile(globalConfig, `[core]\n\thooksPath = ${hooks}\n`);
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
    await runCommand("git", [
      "-C",
      source,
      "config",
      "core.fsmonitor",
      fsmonitor,
    ]);
    const roots = {
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
    };
    const result = await new ContainerLabService(
      "thread-git-environment",
      roots,
      new RecordingDocker(),
      {
        PATH: process.env["PATH"],
        TMPDIR: root,
        HOME: join(root, "ambient-home"),
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_DIR: join(root, "ambient-git-dir"),
        GIT_WORK_TREE: join(root, "ambient-worktree"),
        GIT_ASKPASS: join(root, "ambient-askpass"),
        GIT_SSH_COMMAND: "false",
      },
    ).createLab("git-environment", source);

    expect(result.state).toBe("ready");
    expect(await Bun.file(hookSentinel).exists()).toBe(false);
    expect(await Bun.file(fsmonitorSentinel).exists()).toBe(false);
  });

  test("undeclared source interpolation fails before Docker resources or cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-raw-reject-"));
    trackTemporaryPath(root);
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
    const docker = new RecordingDocker();
    docker.model = { services: { dev: { command: "echo ${HOME}" } } };
    const created = await new ContainerLabService(
      "thread-raw-reject",
      roots,
      docker,
      { PATH: process.env["PATH"], HOME: "/ambient/home" },
    ).createLab("raw-reject", source);

    const lab = await readLab(roots, "thread-raw-reject", created.labId);
    expect(lab.state).toBe("failed");
    expect(lab.error).toContain("interpolation reads undeclared environment");
    expect(docker.runCalls).toHaveLength(1);
    expect(docker.runCalls[0]?.args).toContain("--no-normalize");
    expect(docker.calls.some((args) => args.includes("up"))).toBe(false);
    expect(docker.calls.some((args) => args.includes("rm"))).toBe(false);
  });

  test("rejects inspection drift and reuses a stable source after ready", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "container-lab-compose-binding-"),
    );
    trackTemporaryPath(root);
    const source = join(root, "source");
    const composeFile = join(source, "compose.yaml");
    await runCommand("git", ["init", source]);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "compose: { files: [compose.yaml], command_service: dev }\n",
    );
    await writeFile(
      composeFile,
      "services: { dev: { image: node:24, command: [echo, safe] } }\n",
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
    const dangerous =
      "services: { dev: { image: node:24, command: [sh, -lc, 'echo ${TMPDIR}'] } }\n";
    const safeModel = {
      services: { dev: { image: "node:24", command: ["echo", "safe"] } },
    };
    const dangerousModel = {
      services: {
        dev: {
          image: "node:24",
          command: ["sh", "-lc", "echo ${TMPDIR}"],
        },
      },
    };
    class MutatingComposeDocker extends RecordingDocker {
      private configCalls = 0;
      override async run(
        args: string[],
        options?: Parameters<RecordingDocker["run"]>[1],
      ) {
        if (args.includes("config")) {
          this.configCalls++;
        }
        const result = await super.run(args, options);
        if (this.configCalls === 1 && args.includes("--no-normalize")) {
          await writeFile(composeFile, dangerous);
          this.model = dangerousModel;
        }
        return result;
      }
    }
    const driftingDocker = new MutatingComposeDocker();
    driftingDocker.model = safeModel;
    const driftingService = new ContainerLabService(
      "thread-compose-binding",
      roots,
      driftingDocker,
      { PATH: process.env["PATH"], TMPDIR: "sentinel-client-temp" },
    );

    const rejected = await driftingService.createLab("compose-drift", source);
    expect(rejected.state).toBe("failed");
    const rejectedLab = await readLab(
      roots,
      "thread-compose-binding",
      rejected.labId,
    );
    expect(rejectedLab.error).toBe(
      "Docker Compose source changed during inspection; retry lab creation",
    );
    expect(driftingDocker.calls.some((args) => args.includes("up"))).toBe(
      false,
    );

    await writeFile(
      composeFile,
      "services: { dev: { image: node:24, command: [echo, safe] } }\n",
    );
    const docker = new RecordingDocker();
    docker.model = safeModel;
    const service = new ContainerLabService(
      "thread-compose-stable",
      roots,
      docker,
      { PATH: process.env["PATH"], TMPDIR: "sentinel-client-temp" },
    );
    const created = await service.createLab("compose-stable", source);
    expect(created.state).toBe("ready");
    const lab = await readLab(roots, "thread-compose-stable", created.labId);
    const runtime = lab.runtime;
    if (!runtime?.sourceFile) {
      throw new Error("expected immutable Compose source");
    }
    expect(readFileSync(runtime.sourceFile, "utf8")).toBe(
      JSON.stringify(safeModel),
    );

    const upCall = docker.runCalls.find((call) => call.args.includes("up"));
    expect(upCall?.args).toContain(runtime.sourceFile);
    expect(upCall?.args).not.toContain(composeFile);
    expect(upCall?.args).toContain("/dev/null");

    await writeFile(
      composeFile,
      "services: { dev: { image: node:24, privileged: true } }\n",
    );
    const beforeLifecycle = docker.runCalls.length;
    await service.labStatus(created.labId);
    await service.logs(created.labId, "dev", 10);
    for (const call of docker.runCalls.slice(beforeLifecycle)) {
      expect(call.args).toContain(runtime.sourceFile);
      expect(call.args).not.toContain(composeFile);
    }
  });

  test("create provisions synchronously and returns only lab identity and terminal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-create-"));
    trackTemporaryPath(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "image: { name: node:24, service: dev }\ncompose_environment: [PROJECT_VARIANT]\n",
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
    const lab = await readLab(roots, "thread-create", result.labId);
    expect(lab.state).toBe("ready");
    expect(lab.composeEnvironment).toEqual(["PROJECT_VARIANT"]);
    expect(lab.runtime?.config.composeEnvironment).toEqual(["PROJECT_VARIANT"]);
  });

  test("persists only secret names and never exposes the provisioning value", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-create-"));
    trackTemporaryPath(root);
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
    if (!runtime?.sourceFile) {
      throw new Error("expected ready immutable Compose source");
    }
    expect(runtime.baseFile).toBeUndefined();
    expect(readFileSync(runtime.sourceFile, "utf8")).not.toContain(sentinel);
    expect(readFileSync(runtime.overrideFile, "utf8")).not.toContain(sentinel);
    expect(JSON.stringify(await service.labStatus(lab.id))).not.toContain(
      sentinel,
    );

    const carryingSecret = docker.runCalls.filter(
      (call) => call.options?.env?.["REGISTRY_TOKEN"] === sentinel,
    );
    expect(carryingSecret).toHaveLength(1);
    expect(carryingSecret[0]?.args).toContain("up");
    expect(docker.calls.every((args) => !args.includes(sentinel))).toBe(true);
  });

  test("fails before Docker when a declared secret environment value is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-missing-"));
    trackTemporaryPath(root);
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
    trackTemporaryPath(root);
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
      (call) => !call.args.includes("up"),
    )) {
      expect(Object.hasOwn(call.options?.env ?? {}, "REGISTRY_TOKEN")).toBe(
        false,
      );
    }
  });

  test("health uses only Docker client environment capabilities", async () => {
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

  test("loads legacy version-1 ready state without environment metadata", async () => {
    const fixture = await durableFixture("thread-legacy-ready", "ready", true);
    const path = labManifestPath(
      fixture.roots.stateRoot,
      fixture.owner,
      fixture.lab.id,
    );
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.composeEnvironment;
    delete legacy.runtime.config.composeEnvironment;
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
        .composeEnvironment,
    ).toEqual([]);
    expect(
      (await readLab(fixture.roots, fixture.owner, fixture.lab.id))
        .secretEnvironment,
    ).toEqual([]);
    expect(await service.destroyLab(fixture.lab.id)).toEqual({
      labId: fixture.lab.id,
      destroyed: true,
    });
  });

  test("requires recreation for unbound version-1 runtime but retains destruction", async () => {
    const fixture = await durableFixture("thread-unbound-ready", "ready", true);
    const path = labManifestPath(
      fixture.roots.stateRoot,
      fixture.owner,
      fixture.lab.id,
    );
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.runtime.sourceFile;
    const legacyBase = join(fixture.lab.runtimeRoot, "base.compose.yaml");
    writeFileSync(legacyBase, "services: { dev: {} }\n");
    legacy.runtime.baseFile = legacyBase;
    legacy.runtime.composeArgs = [
      "compose",
      "--project-directory",
      fixture.lab.sourceRoot,
      "--project-name",
      fixture.lab.composeProject,
      "-f",
      legacyBase,
      "-f",
      legacy.runtime.overrideFile,
    ];
    writeFileSync(path, JSON.stringify(legacy));
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      new RecordingDocker(),
    );

    await expect(service.labStatus(fixture.lab.id)).rejects.toThrow(
      "recreate the lab",
    );
    expect(await service.destroyLab(fixture.lab.id)).toEqual({
      labId: fixture.lab.id,
      destroyed: true,
    });
  });

  test("interrupted synchronous provisioning records a recoverable failed lab", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "container-lab-interrupted-create-"),
    );
    trackTemporaryPath(root);
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
