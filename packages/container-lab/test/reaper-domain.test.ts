// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { Database } from "bun:sqlite";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { DockerRunner } from "../src/docker.ts";
import { withFileLock } from "../src/locks.ts";
import type { CommandResult, RunOptions } from "../src/process.ts";
import {
  reapArchivedOwners,
  validateThreadsSchema,
} from "../src/reaper-domain.ts";
import { writeLab } from "../src/state/lab/store.ts";
import {
  labManifestPath,
  ownerDirectory,
  ownerKey,
} from "../src/state/layout.ts";
import { ensureOwner } from "../src/state/owner-store.ts";
import type { LabMetadata } from "../src/types.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

class EmptyDocker implements DockerRunner {
  calls: string[][] = [];
  runCalls: Array<{ args: string[]; options?: RunOptions }> = [];
  // biome-ignore lint/suspicious/useAwait: The async signature implements a promise-returning test double contract.
  async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, ...(options === undefined ? {} : { options }) });
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  spawn(): ChildProcessWithoutNullStreams {
    throw new Error("reaper never spawns");
  }
}

describe("archive reaper", () => {
  test("cleans archived exact owners and retains active and missing rows", async () => {
    const fixture = await roots();
    const archived = await createLabFixture(fixture, "thread-archived");
    await createLabFixture(fixture, "thread-active");
    await createLabFixture(fixture, "thread-missing");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.run("INSERT INTO threads VALUES (?, 1, 10)", ["thread-archived"]);
    db.run("INSERT INTO threads VALUES (?, 0, NULL)", ["thread-active"]);
    db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker });
    expect(result.archivedOwnersCleaned).toEqual([archived.ownerKey]);
    expect(result.retainedOwners).toHaveLength(2);
    expect(docker.calls.every((args) => !args.includes("down"))).toBe(true);
  });

  test("schema mismatch and unavailable database fail closed without Docker", async () => {
    const fixture = await roots();
    await createLabFixture(fixture, "thread-safe");
    const malformed = join(fixture.root, "malformed.sqlite");
    const db = new Database(malformed);
    db.run("CREATE TABLE threads (id TEXT PRIMARY KEY)");
    db.close();
    const docker = new EmptyDocker();
    expect(
      (await reapArchivedOwners({ dbPath: malformed, roots: fixture, docker }))
        .ok,
    ).toBe(false);
    expect(
      (
        await reapArchivedOwners({
          dbPath: join(fixture.root, "missing.sqlite"),
          roots: fixture,
          docker,
        })
      ).ok,
    ).toBe(false);
    expect(docker.calls).toEqual([]);
  });

  test("rechecks immediately and retains an owner whose archive state changes", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-flip");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.close();
    let reads = 0;
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({
      dbPath,
      roots: fixture,
      docker,
      stateReader: () => (++reads === 1 ? "archived" : "active"),
    });
    expect(result.archivedOwnersCleaned).toEqual([]);
    expect(result.retainedOwners[0]?.ownerKey).toBe(lab.ownerKey);
    expect(docker.calls).toEqual([]);
  });

  test("reads WAL state in place and validates the exact read-only schema", async () => {
    const fixture = await roots();
    const dbPath = join(fixture.root, "wal.sqlite");
    const writer = createDatabase(dbPath);
    writer.run("PRAGMA journal_mode=WAL");
    writer.run("INSERT INTO threads VALUES (?, 0, NULL)", ["thread-active"]);
    const reader = new Database(dbPath, { readonly: true, strict: true });
    expect(() => validateThreadsSchema(reader)).not.toThrow();
    expect(() => reader.run("UPDATE threads SET archived=1")).toThrow();
    reader.close();
    writer.close();
  });

  test("a symlinked runtime owner is retained without outside deletion or Docker", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-symlink");
    const ownerRuntime = join(fixture.runtimeRoot, lab.ownerKey);
    const outside = join(fixture.root, "outside");
    await rm(ownerRuntime, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "keep");
    await symlink(outside, ownerRuntime, "dir");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.run("INSERT INTO threads VALUES (?, 1, 10)", [lab.owner]);
    db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker });
    expect(result.ok).toBe(false);
    expect(await Bun.file(join(outside, "sentinel")).text()).toBe("keep");
    expect(docker.calls).toEqual([]);
  });

  test("an already-missing runtime remains safely cleanable", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-missing-runtime");
    await rm(join(fixture.runtimeRoot, lab.ownerKey), { recursive: true });
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.run("INSERT INTO threads VALUES (?, 1, 10)", [lab.owner]);
    db.close();

    const result = await reapArchivedOwners({
      dbPath,
      roots: fixture,
      docker: new EmptyDocker(),
    });

    expect(result.archivedOwnersCleaned).toEqual([lab.ownerKey]);
    expect(result.ok).toBe(true);
  });

  test("a replaced owner state directory is retained without outside deletion or Docker", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-replaced-state");
    const ownerState = ownerDirectory(fixture.stateRoot, lab.owner);
    const outside = join(fixture.root, "outside-owner-state");
    const sentinel = join(outside, "sentinel.txt");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.run("INSERT INTO threads VALUES (?, 1, 10)", [lab.owner]);
    db.close();
    const docker = new EmptyDocker();

    const result = await reapArchivedOwners({
      dbPath,
      roots: fixture,
      docker,
      beforeOwnerLock: async () => {
        await rename(ownerState, outside);
        await writeFile(sentinel, "keep");
        await symlink(outside, ownerState, "dir");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.retainedOwners[0]?.reason).toContain("unsafe indirection");
    expect(await Bun.file(sentinel).text()).toBe("keep");
    expect(docker.calls).toEqual([]);
  });

  test("an escaped persisted runtime is retained before Docker", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-escaped-runtime");
    const manifest = labManifestPath(fixture.stateRoot, lab.owner, lab.id);
    const persisted = JSON.parse(await readFile(manifest, "utf8"));
    persisted.runtimeRoot = join(fixture.root, "outside");
    persisted.workspace = join(persisted.runtimeRoot, "workspace");
    await writeFile(manifest, JSON.stringify(persisted));
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.run("INSERT INTO threads VALUES (?, 1, 10)", [lab.owner]);
    db.close();
    const docker = new EmptyDocker();

    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker });

    expect(result.ok).toBe(false);
    expect(result.retainedOwners[0]?.reason).toContain("invalid lab manifest");
    expect(docker.calls).toEqual([]);
  });

  test("an initial query failure aborts the scan before cleanup", async () => {
    const fixture = await roots();
    await createLabFixture(fixture, "thread-query-error");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({
      dbPath,
      roots: fixture,
      docker,
      stateReader: () => {
        throw new Error("busy");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.archivedOwnersCleaned).toEqual([]);
    expect(docker.calls).toEqual([]);
  });

  test("cleanup removes exact containers before waiting for activity, then removes filesystem state", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-active-cleanup");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.run("INSERT INTO threads VALUES (?, 1, 10)", [lab.owner]);
    db.close();
    const activity = join(
      fixture.stateRoot,
      "owners",
      lab.ownerKey,
      ".locks",
      `activity-${lab.id}`,
    );
    const release = Promise.withResolvers<void>();
    const held = withFileLock(activity, async () => await release.promise);
    await Bun.sleep(20);
    const docker = new EmptyDocker();
    let finished = false;
    const reaping = reapArchivedOwners({ dbPath, roots: fixture, docker }).then(
      (result) => {
        finished = true;
        return result;
      },
    );
    for (
      let attempt = 0;
      attempt < 100 && docker.calls.length === 0;
      attempt++
    ) {
      await Bun.sleep(10);
    }
    expect(docker.calls.length).toBeGreaterThan(0);
    expect(finished).toBe(false);
    release.resolve();
    await held;
    expect((await reaping).archivedOwnersCleaned).toEqual([lab.ownerKey]);
  });

  test("cleanup scrubs persisted secret names from every reaper Docker subprocess", async () => {
    const fixture = await roots();
    const secretName = "CODEX_CONTAINER_LAB_REAPER_TEST_SECRET";
    const previous = process.env[secretName];
    process.env[secretName] = "sentinel-reaper-token";
    try {
      const lab = await createLabFixture(fixture, "thread-secret-reaper", [
        secretName,
      ]);
      const dbPath = join(fixture.root, "state.sqlite");
      const db = createDatabase(dbPath);
      db.run("INSERT INTO threads VALUES (?, 1, 10)", [lab.owner]);
      db.close();
      const docker = new EmptyDocker();

      expect(
        (await reapArchivedOwners({ dbPath, roots: fixture, docker }))
          .archivedOwnersCleaned,
      ).toEqual([lab.ownerKey]);
      expect(docker.runCalls.length).toBeGreaterThan(0);
      expect(
        docker.runCalls.every(
          (call) => !Object.hasOwn(call.options?.env ?? {}, secretName),
        ),
      ).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env[secretName];
      } else {
        process.env[secretName] = previous;
      }
    }
  });
});

function createDatabase(path: string): Database {
  const db = new Database(path);
  db.run(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER)",
  );
  return db;
}

async function roots() {
  const root = await mkdtemp(join(tmpdir(), "container-lab-reaper-"));
  temporary.push(root);
  return {
    root,
    stateRoot: join(root, "state"),
    runtimeRoot: join(root, "runtime"),
  };
}

async function createLabFixture(
  rootsValue: Awaited<ReturnType<typeof roots>>,
  owner: string,
  secretEnvironment: string[] = [],
): Promise<LabMetadata> {
  await ensureOwner(rootsValue.stateRoot, owner);
  const key = ownerKey(owner);
  const runtimeRoot = join(rootsValue.runtimeRoot, key, "lab-1");
  const sourceRoot = join(rootsValue.root, `${key}-source`);
  await mkdir(join(runtimeRoot, "workspace"), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  const lab: LabMetadata = {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner,
    ownerKey: key,
    // biome-ignore lint/security/noSecrets: This fixed test/schema token is not a credential.
    repoHash: "123456789abc",
    composeProject: "ccl-reaper",
    state: "failed",
    sourceRoot,
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(sourceRoot, ".codex-container-lab.yaml"),
    commandService: "dev",
    modeKind: "image",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment,
  };
  await writeLab(rootsValue, lab);
  return lab;
}
