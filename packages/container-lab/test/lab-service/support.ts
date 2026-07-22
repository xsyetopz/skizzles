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
import type { DockerRunner, DockerSpawnOptions } from "../../src/docker.ts";
import { ContainerLabService } from "../../src/lab/orchestrator.ts";
import { withFileLock } from "../../src/locks.ts";
import type { CommandResult, RunOptions } from "../../src/process.ts";
import { runCommand } from "../../src/process.ts";
import type { LabMetadata } from "../../src/state/lab/contract.ts";
import { readLab, writeLab } from "../../src/state/lab/store.ts";
import {
  labLockPath,
  labManifestPath,
  labsDirectory,
  ownerDirectory,
  ownerKey,
} from "../../src/state/layout.ts";
import { ensureOwner } from "../../src/state/owner-store.ts";

export class RecordingDocker implements DockerRunner {
  calls: string[][] = [];
  runCalls: Array<{ args: string[]; options?: RunOptions }> = [];
  spawnCalls: Array<{ args: string[]; options?: DockerSpawnOptions }> = [];
  child?: ChildProcessWithoutNullStreams;
  private readonly childSpawned =
    Promise.withResolvers<ChildProcessWithoutNullStreams>();
  model: unknown = { services: { dev: {} } };

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

export class SecretDiagnosticDocker extends RecordingDocker {
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

export class InterruptingDocker extends RecordingDocker {
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

export class DestructiveDocker extends RecordingDocker {
  private listed = false;

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

export class TerminatingDocker extends RecordingDocker {
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
async function provisionedSyncFixture(
  trackTemporaryPath: (root: string) => string,
  owner: string,
) {
  const root = trackTemporaryPath(
    await mkdtemp(join(tmpdir(), "container-lab-sync-service-")),
  );
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

export async function crashServiceApply(
  lab: LabMetadata,
  token: string,
  direction: "push" | "pull" = "push",
): Promise<void> {
  let sourceRoot = lab.sourceRoot;
  let targetRoot = lab.workspace;
  if (direction === "pull") {
    sourceRoot = lab.workspace;
    targetRoot = lab.sourceRoot;
  }
  const modulePath = join(
    import.meta.dir,
    "../../src/sync/transaction/apply.ts",
  );
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
        direction,
        sourceRoot,
        targetRoot,
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

export async function syncJournals(lab: LabMetadata): Promise<string[]> {
  return await readdir(join(lab.runtimeRoot, "sync", lab.id, "journals"));
}

async function durableFixture(
  trackTemporaryPath: (root: string) => string,
  owner: string,
  state: LabMetadata["state"],
  createRuntime = false,
) {
  const root = trackTemporaryPath(
    await mkdtemp(join(tmpdir(), "container-lab-durable-")),
  );
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
    await writeFile(
      join(runtimeRoot, "source.compose.json"),
      '{"services":{"dev":{}}}',
    );
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

    repoHash: ["123456", "789abc"].join(""),
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
    composeEnvironment: [],
    secretEnvironment: [],
    ...(state === "ready"
      ? { runtime: readyRuntime(sourceRoot, runtimeRoot) }
      : {}),
  };
  await writeLab(roots, lab);
  return { root, roots, owner, lab };
}

export async function replaceLabWithSymlink(
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

export function createLabServiceFixtureScope() {
  const temporary = new Set<string>();

  function trackTemporaryPath(root: string): string {
    temporary.add(root);
    return root;
  }

  async function cleanup(): Promise<void> {
    const roots = [...temporary];
    temporary.clear();
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  return {
    cleanup,
    durableFixture: (
      owner: string,
      state: LabMetadata["state"],
      createRuntime = false,
    ) => durableFixture(trackTemporaryPath, owner, state, createRuntime),
    provisionedSyncFixture: (owner: string) =>
      provisionedSyncFixture(trackTemporaryPath, owner),
    trackTemporaryPath,
  };
}

export function readyRuntime(
  sourceRoot: string,
  runtimeRoot: string,
): NonNullable<LabMetadata["runtime"]> {
  const sourceFile = join(runtimeRoot, "source.compose.json");
  const overrideFile = join(runtimeRoot, "override.compose.yaml");
  return {
    config: {
      repoRoot: sourceRoot,
      manifestPath: join(sourceRoot, ".codex-container-lab.yaml"),
      mode: { kind: "image", image: "node:24", commandService: "dev" },
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      composeEnvironment: [],
      secretEnvironment: [],
    },
    composeArgs: [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-directory",
      sourceRoot,
      "--project-name",
      "ccl-durable",
      "-f",
      sourceFile,
      "-f",
      overrideFile,
    ],
    sourceFile,
    overrideFile,
    findings: [],
  };
}

export type { LabMetadata };
export {
  ContainerLabService,
  ensureOwner,
  join,
  labLockPath,
  labManifestPath,
  labsDirectory,
  mkdir,
  mkdtemp,
  ownerDirectory,
  ownerKey,
  PassThrough,
  process,
  readdir,
  readFileSync,
  readLab,
  rename,
  rm,
  runCommand,
  symlink,
  tmpdir,
  withFileLock,
  writeFile,
  writeFileSync,
  writeLab,
};
