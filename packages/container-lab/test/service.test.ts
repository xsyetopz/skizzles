// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import type { DockerRunner, DockerSpawnOptions } from "../src/docker.ts";
import { withFileLock } from "../src/locks.ts";
import type { CommandResult, RunOptions } from "../src/process.ts";
import { runCommand } from "../src/process.ts";
import { ContainerLabService } from "../src/service.ts";
import {
  ensureOwner,
  labLockPath,
  labManifestPath,
  labsDirectory,
  ownerDirectory,
  ownerKey,
  readLab,
  writeLab,
} from "../src/state.ts";
import type { LabMetadata } from "../src/types.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

class RecordingDocker implements DockerRunner {
  calls: string[][] = [];
  runCalls: Array<{ args: string[]; options?: RunOptions }> = [];
  spawnCalls: Array<{ args: string[]; options?: DockerSpawnOptions }> = [];
  child?: ChildProcessWithoutNullStreams;
  private readonly childSpawned =
    Promise.withResolvers<ChildProcessWithoutNullStreams>();
  model: unknown = { services: { dev: {} } };
  // biome-ignore lint/suspicious/useAwait: The async signature implements a promise-returning test double contract.
  async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, ...(options === undefined ? {} : { options }) });
    if (args.includes("config")) {
      return {
        code: 0,
        stdout: Buffer.from(JSON.stringify(this.model)),
        stderr: Buffer.alloc(0),
      };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  spawn(
    args: string[],
    options?: DockerSpawnOptions,
  ): ChildProcessWithoutNullStreams {
    this.calls.push(args);
    this.spawnCalls.push({
      args,
      ...(options === undefined ? {} : { options }),
    });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
    });
    this.child = child;
    this.childSpawned.resolve(child);
    return child;
  }

  async waitForChildSpawn(): Promise<ChildProcessWithoutNullStreams> {
    return await this.childSpawned.promise;
  }
}

class SecretDiagnosticDocker extends RecordingDocker {
  private readonly sentinel: string;
  constructor(sentinel: string) {
    super();
    this.sentinel = sentinel;
  }
  override async run(
    args: string[],
    options?: RunOptions,
  ): Promise<CommandResult> {
    if (args.includes("config")) {
      this.calls.push(args);
      this.runCalls.push({
        args,
        ...(options === undefined ? {} : { options }),
      });
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(`secret diagnostic: ${this.sentinel}`),
      };
    }
    return await super.run(args, options);
  }
}

class InterruptingDocker extends RecordingDocker {
  private readonly controller: AbortController;
  constructor(controller: AbortController) {
    super();
    this.controller = controller;
  }
  override async run(
    args: string[],
    options?: RunOptions,
  ): Promise<CommandResult> {
    if (args.includes("up")) {
      this.calls.push(args);
      this.controller.abort("SIGTERM");
      throw new Error("docker compose up aborted");
    }
    return await super.run(args, options);
  }
}

class DestructiveDocker extends RecordingDocker {
  private listed = false;
  // biome-ignore lint/suspicious/useAwait: The async signature implements a promise-returning test double contract.
  override async run(
    args: string[],
    _options?: RunOptions,
  ): Promise<CommandResult> {
    this.calls.push(args);
    if (args[0] === "ps" && args[1] === "-aq" && !this.listed) {
      this.listed = true;
      return {
        code: 0,
        stdout: Buffer.from("container-1\n"),
        stderr: Buffer.alloc(0),
      };
    }
    if (args[0] === "rm" && args[1] === "-f") {
      const child = this.child;
      if (!child) {
        throw new Error("cleanup occurred before attached launch");
      }
      Object.assign(child, { exitCode: 137 });
      child.emit("close", 137);
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

class TerminatingDocker extends RecordingDocker {
  override async run(
    args: string[],
    options?: RunOptions,
  ): Promise<CommandResult> {
    const script = args.find((arg) =>
      arg.includes("codex-container-lab-termination:"),
    );
    if (script) {
      this.calls.push(args);
      this.runCalls.push({
        args,
        ...(options === undefined ? {} : { options }),
      });
      const child = this.child;
      if (!child) {
        throw new Error("termination occurred before test launch");
      }
      Object.assign(child, { exitCode: 143 });
      child.emit("close", 143);
      return {
        code: 0,
        stdout: Buffer.from("codex-container-lab-termination:signaled\n"),
        stderr: Buffer.alloc(0),
      };
    }
    return await super.run(args, options);
  }
}

describe("attached service lifecycle", () => {
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

  test("streams an attached argv run and returns its exact exit status", async () => {
    const fixture = await durableFixture("thread-run", "ready", true);
    const docker = new RecordingDocker();
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      docker,
    );
    let stdout = "";
    let stderr = "";
    let stdin = "";
    const input = new PassThrough();
    const running = service.run(
      fixture.lab.id,
      ["printf", "%s", "hello world"],
      ".",
      {},
      30,
      {
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: (chunk) => {
          stderr += chunk;
        },
        stdin: input,
      },
    );
    const child = await docker.waitForChildSpawn();
    child.stdin.on("data", (chunk) => {
      stdin += chunk;
    });
    input.write("interactive-input\n");
    (child.stdout as PassThrough).write("early\n");
    (child.stderr as PassThrough).write("warning\n");
    expect(stdout).toBe("early\n");
    expect(stderr).toBe("warning\n");
    expect(stdin).toBe("interactive-input\n");
    Object.assign(child, { exitCode: 23 });
    child.emit("close", 23);
    expect(await running).toBe(23);
    expect(docker.calls.find((call) => call.includes("exec"))).toContain(
      "hello world",
    );
  });

  test("an already-aborted run never launches a container process", async () => {
    const fixture = await durableFixture("thread-pre-abort", "ready", true);
    const docker = new RecordingDocker();
    const controller = new AbortController();
    controller.abort("SIGINT");
    expect(
      await new ContainerLabService(fixture.owner, fixture.roots, docker).run(
        fixture.lab.id,
        ["true"],
        ".",
        {},
        30,
        { stdout: () => undefined, stderr: () => undefined },
        controller.signal,
      ),
    ).toBe(130);
    expect(docker.child).toBeUndefined();
  });

  test("run request validation precedes durable-state reconciliation", async () => {
    const fixture = await durableFixture(
      "thread-invalid-run-order",
      "ready",
      true,
    );
    await rm(fixture.lab.runtimeRoot, { recursive: true, force: true });
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      new RecordingDocker(),
    );

    await expect(
      service.run(fixture.lab.id, [], ".", {}, 30, {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).rejects.toThrow("run argv must contain 1..256 bounded arguments");
    expect(
      (await readLab(fixture.roots, fixture.owner, fixture.lab.id)).state,
    ).toBe("ready");
  });

  test("SIGTERM after launch terminates the exact attached run and returns 143", async () => {
    const fixture = await durableFixture("thread-term-run", "ready", true);
    const docker = new TerminatingDocker();
    const controller = new AbortController();
    const running = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      docker,
    ).run(
      fixture.lab.id,
      ["sleep", "100"],
      ".",
      {},
      0,
      { stdout: () => undefined, stderr: () => undefined },
      controller.signal,
    );
    await docker.waitForChildSpawn();

    controller.abort("SIGTERM");

    expect(await running).toBe(143);
    expect(
      docker.calls.some((args) =>
        args.some(
          (arg) =>
            arg.includes("codex-container-lab-termination:") &&
            arg.includes("kill -TERM"),
        ),
      ),
    ).toBe(true);
  });

  test("destroy removes exact containers first, then waits for attached activity before filesystem cleanup", async () => {
    const fixture = await durableFixture(
      "thread-destroy-active",
      "ready",
      true,
    );
    const docker = new DestructiveDocker();
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      docker,
    );
    const running = service.run(fixture.lab.id, ["sleep", "100"], ".", {}, 0, {
      stdout: () => undefined,
      stderr: () => undefined,
    });
    await docker.waitForChildSpawn();
    expect(await service.destroyLab(fixture.lab.id)).toEqual({
      labId: fixture.lab.id,
      destroyed: true,
    });
    expect(await running).toBe(137);
    expect(
      docker.calls.some(
        (args) =>
          args[0] === "rm" && args[1] === "-f" && args.includes("container-1"),
      ),
    ).toBe(true);
  });

  test("a tampered runtime path fails closed before destroy touches Docker or outside data", async () => {
    const fixture = await durableFixture("thread-tampered", "failed");
    const sentinel = join(fixture.root, "outside", "sentinel.txt");
    await mkdir(join(fixture.root, "outside"), { recursive: true });
    await writeFile(sentinel, "keep");
    const path = labManifestPath(
      fixture.roots.stateRoot,
      fixture.owner,
      fixture.lab.id,
    );
    const corrupted = JSON.parse(readFileSync(path, "utf8"));
    corrupted.runtimeRoot = join(fixture.root, "outside");
    corrupted.workspace = join(fixture.root, "outside", "workspace");
    writeFileSync(path, JSON.stringify(corrupted));
    const docker = new RecordingDocker();
    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).destroyLab(
        fixture.lab.id,
      ),
    ).rejects.toThrow("invalid lab manifest");
    expect(await Bun.file(sentinel).text()).toBe("keep");
    expect(docker.calls).toEqual([]);
  });

  test("a symlinked owner runtime parent fails closed before cleanup", async () => {
    const fixture = await durableFixture(
      "thread-destroy-symlink",
      "ready",
      true,
    );
    const ownerRuntime = join(fixture.roots.runtimeRoot, fixture.lab.ownerKey);
    const outside = join(fixture.root, "outside-runtime-owner");
    await rename(ownerRuntime, outside);
    await symlink(outside, ownerRuntime, "dir");
    const docker = new RecordingDocker();
    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).destroyLab(
        fixture.lab.id,
      ),
    ).rejects.toThrow("unsafe indirection");
    expect(docker.calls).toEqual([]);
  });

  test("destroy accepts an already-missing runtime but still removes exact state", async () => {
    const fixture = await durableFixture("thread-destroy-missing", "failed");
    const docker = new RecordingDocker();

    expect(
      await new ContainerLabService(
        fixture.owner,
        fixture.roots,
        docker,
      ).destroyLab(fixture.lab.id),
    ).toEqual({ labId: fixture.lab.id, destroyed: true });
    await expect(
      readLab(fixture.roots, fixture.owner, fixture.lab.id),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await new ContainerLabService(
        fixture.owner,
        fixture.roots,
        docker,
      ).destroyLab(fixture.lab.id),
    ).toEqual({ labId: fixture.lab.id, destroyed: false });
  });

  test("a replaced owner state directory fails closed before Docker or outside cleanup", async () => {
    const fixture = await durableFixture(
      "thread-destroy-replaced-state",
      "ready",
      true,
    );
    const ownerState = ownerDirectory(fixture.roots.stateRoot, fixture.owner);
    const outside = join(fixture.root, "outside-owner-state");
    const sentinel = join(outside, "sentinel.txt");
    await rename(ownerState, outside);
    await writeFile(sentinel, "keep");
    await symlink(outside, ownerState, "dir");
    const docker = new RecordingDocker();

    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).destroyLab(
        fixture.lab.id,
      ),
    ).rejects.toThrow("unsafe indirection");
    expect(await Bun.file(sentinel).text()).toBe("keep");
    expect(docker.calls).toEqual([]);
  });

  test("health and status reject a symlinked durable lab file before Docker", async () => {
    for (const operation of ["health", "status"] as const) {
      const fixture = await durableFixture(
        `thread-read-${operation}`,
        "failed",
      );
      await replaceLabWithSymlink(fixture);
      const docker = new RecordingDocker();
      const service = new ContainerLabService(
        fixture.owner,
        fixture.roots,
        docker,
      );

      const result =
        operation === "health"
          ? service.health()
          : service.labStatus(fixture.lab.id);
      await expect(result).rejects.toThrow(
        "lab state file contains unsafe indirection",
      );
      expect(docker.calls).toEqual([]);
    }
  });

  test("provisioning rejects a symlinked durable-state parent before source or Docker access", async () => {
    const fixture = await durableFixture("thread-read-provision", "failed");
    const labs = labsDirectory(fixture.roots.stateRoot, fixture.owner);
    const outside = join(fixture.root, "outside-labs");
    await rename(labs, outside);
    await symlink(outside, labs, "dir");
    const docker = new RecordingDocker();

    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).createLab(
        "new-lab",
        join(fixture.root, "missing-source"),
      ),
    ).rejects.toThrow("lab state directory contains unsafe indirection");
    expect(docker.calls).toEqual([]);
  });

  test("provisioning rejects a symlinked reaped-owner marker parent before source or Docker access", async () => {
    const fixture = await durableFixture("thread-read-marker", "failed");
    const outside = join(fixture.root, "outside-reaped");
    await mkdir(outside);
    await symlink(outside, join(fixture.roots.stateRoot, "reaped"), "dir");
    const docker = new RecordingDocker();

    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).createLab(
        "new-lab",
        join(fixture.root, "missing-source"),
      ),
    ).rejects.toThrow("reaped owner marker parent contains unsafe indirection");
    expect(docker.calls).toEqual([]);
  });

  test("run rejects a symlinked durable lab file before attached execution", async () => {
    const fixture = await durableFixture("thread-read-run", "failed");
    await replaceLabWithSymlink(fixture);
    const docker = new RecordingDocker();

    await expect(
      new ContainerLabService(fixture.owner, fixture.roots, docker).run(
        fixture.lab.id,
        ["true"],
        ".",
        {},
        1,
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toThrow("lab state file contains unsafe indirection");
    expect(docker.calls).toEqual([]);
  });

  test("public lab views omit internal persistence fields", async () => {
    const fixture = await durableFixture("thread-output", "failed");
    const service = new ContainerLabService(
      fixture.owner,
      fixture.roots,
      new RecordingDocker(),
    );
    const encoded = JSON.stringify(await service.labStatus(fixture.lab.id));
    for (const forbidden of [
      "ownerKey",
      "runtimeRoot",
      "sourceRoot",
      "composeArgs",
      "manifestPath",
      fixture.lab.ownerKey,
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(encoded)).toBeLessThan(16 * 1024);
  });

  test("durable runtime validation rejects invalid and overlapping secret environment names", async () => {
    const fixture = await durableFixture("thread-secret-state", "ready", true);
    const runtime = fixture.lab.runtime;
    if (!runtime) {
      throw new Error("expected ready runtime");
    }
    runtime.config.secretEnvironment = ["BAD-NAME"];
    await expect(writeLab(fixture.roots, fixture.lab)).rejects.toThrow(
      "invalid secret environment",
    );
    runtime.config.secretEnvironment = ["TERM"];
    runtime.config.forwardEnvironment = ["TERM"];
    await expect(writeLab(fixture.roots, fixture.lab)).rejects.toThrow(
      "invalid secret environment",
    );
  });

  test("recovers a crash journal before issuing a new service preview", async () => {
    const fixture = await provisionedSyncFixture(
      "thread-sync-preview-recovery",
    );
    await writeFile(join(fixture.lab.sourceRoot, "tracked.txt"), "changed\n");
    const crashed = await fixture.service.preview(fixture.lab.id, "push");
    await crashServiceApply(fixture.lab, crashed.token);
    expect(
      await Bun.file(join(fixture.lab.workspace, "tracked.txt")).text(),
    ).toBe("changed\n");

    const preview = await fixture.service.preview(fixture.lab.id, "push");

    expect(preview.changes.map((change) => change.path)).toEqual([
      "tracked.txt",
    ]);
    expect(
      await Bun.file(join(fixture.lab.workspace, "tracked.txt")).text(),
    ).toBe("base\n");
    expect(await syncJournals(fixture.lab)).toEqual([]);
  });

  test("recovers a crash journal before consuming an existing service apply token", async () => {
    const fixture = await provisionedSyncFixture("thread-sync-apply-recovery");
    await writeFile(join(fixture.lab.sourceRoot, "tracked.txt"), "changed\n");
    const crashed = await fixture.service.preview(fixture.lab.id, "push");
    const pending = await fixture.service.preview(fixture.lab.id, "push");
    await crashServiceApply(fixture.lab, crashed.token);

    expect(
      await fixture.service.apply(fixture.lab.id, "push", pending.token),
    ).toEqual({ labId: fixture.lab.id, direction: "push", applied: 1 });
    expect(
      await Bun.file(join(fixture.lab.workspace, "tracked.txt")).text(),
    ).toBe("changed\n");
    expect(await syncJournals(fixture.lab)).toEqual([]);
  });

  test("serializes concurrent preview and apply with activity then lab lock ordering", async () => {
    const fixture = await provisionedSyncFixture("thread-sync-lock-order");
    const token = (await fixture.service.preview(fixture.lab.id, "push")).token;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = withFileLock(
      labLockPath(fixture.roots.stateRoot, fixture.owner, fixture.lab.id),
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    let previewSettled = false;
    let applySettled = false;
    const preview = fixture.service
      .preview(fixture.lab.id, "push")
      .finally(() => {
        previewSettled = true;
      });
    const apply = fixture.service
      .apply(fixture.lab.id, "push", token)
      .finally(() => {
        applySettled = true;
      });
    try {
      await Bun.sleep(100);
      expect(previewSettled).toBe(false);
      expect(applySettled).toBe(false);
    } finally {
      release.resolve();
    }
    await held;
    await Promise.all([preview, apply]);
  });
});

async function provisionedSyncFixture(owner: string) {
  const root = await mkdtemp(join(tmpdir(), "container-lab-sync-service-"));
  temporary.push(root);
  const source = join(root, "source");
  await runCommand("git", ["init", source]);
  await writeFile(
    join(source, ".codex-container-lab.yaml"),
    "image: { name: node:24, service: dev }\n",
  );
  await writeFile(join(source, "tracked.txt"), "base\n");
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
  const service = new ContainerLabService(owner, roots, new RecordingDocker());
  const created = await service.createLab("sync", source);
  const lab = await readLab(roots, owner, created.labId);
  return { root, roots, owner, service, lab };
}

async function crashServiceApply(
  lab: LabMetadata,
  token: string,
): Promise<void> {
  const modulePath = join(import.meta.dir, "../src/sync-apply.ts");
  const script = `
    const { applySyncWithHooks } = await import(${JSON.stringify(modulePath)});
    const options = JSON.parse(process.env.SYNC_CRASH_OPTIONS);
    await applySyncWithHooks(
      { ...options, idleGuard: () => true },
      { afterPathPublished: () => process.exit(86) },
    );
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      SYNC_CRASH_OPTIONS: JSON.stringify({
        stateRoot: lab.runtimeRoot,
        labId: lab.id,
        direction: "push",
        sourceRoot: lab.sourceRoot,
        targetRoot: lab.workspace,
        token,
      }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 86) {
    throw new Error(`Crash fixture exited ${exitCode}: ${stderr}`);
  }
}

async function syncJournals(lab: LabMetadata): Promise<string[]> {
  return await readdir(join(lab.runtimeRoot, "sync", lab.id, "journals"));
}

async function durableFixture(
  owner: string,
  state: LabMetadata["state"],
  createRuntime = false,
) {
  const root = await mkdtemp(join(tmpdir(), "container-lab-durable-"));
  temporary.push(root);
  const roots = {
    stateRoot: join(root, "state"),
    runtimeRoot: join(root, "runtime"),
  };
  const key = ownerKey(owner);
  const runtimeRoot = join(roots.runtimeRoot, key, "lab-1");
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  if (createRuntime) {
    await mkdir(join(runtimeRoot, "workspace"), { recursive: true });
    await writeFile(
      join(sourceRoot, ".codex-container-lab.yaml"),
      "image: { name: node:24, service: dev }\n",
    );
    await writeFile(join(runtimeRoot, "base.compose.yaml"), "services: {}\n");
    await writeFile(
      join(runtimeRoot, "override.compose.yaml"),
      "services: {}\n",
    );
  }
  await ensureOwner(roots.stateRoot, owner);
  const lab: LabMetadata = {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner,
    ownerKey: key,
    // biome-ignore lint/security/noSecrets: This fixed test/schema token is not a credential.
    repoHash: "123456789abc",
    composeProject: "ccl-durable",
    state,
    sourceRoot,
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(sourceRoot, ".codex-container-lab.yaml"),
    commandService: state === "ready" ? "dev" : "pending",
    ...(state === "ready" ? { modeKind: "image" as const } : {}),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment: [],
    ...(state === "ready"
      ? { runtime: readyRuntime(sourceRoot, runtimeRoot) }
      : {}),
  };
  await writeLab(roots, lab);
  return { root, roots, owner, lab };
}

async function replaceLabWithSymlink(
  fixture: Awaited<ReturnType<typeof durableFixture>>,
): Promise<void> {
  const path = labManifestPath(
    fixture.roots.stateRoot,
    fixture.owner,
    fixture.lab.id,
  );
  const outside = join(fixture.root, `${fixture.lab.id}-outside.json`);
  await rename(path, outside);
  await symlink(outside, path, "file");
}

function readyRuntime(
  sourceRoot: string,
  runtimeRoot: string,
): NonNullable<LabMetadata["runtime"]> {
  const baseFile = join(runtimeRoot, "base.compose.yaml");
  const overrideFile = join(runtimeRoot, "override.compose.yaml");
  return {
    config: {
      repoRoot: sourceRoot,
      manifestPath: join(sourceRoot, ".codex-container-lab.yaml"),
      mode: { kind: "image", image: "node:24", commandService: "dev" },
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      secretEnvironment: [],
    },
    composeArgs: [
      "compose",
      "--project-directory",
      sourceRoot,
      "--project-name",
      "ccl-durable",
      "-f",
      baseFile,
      "-f",
      overrideFile,
    ],
    baseFile,
    overrideFile,
    findings: [],
  };
}
