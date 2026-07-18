// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { SyncFile } from "../src/files.ts";
import {
  applySync,
  compareManifests,
  initializeSyncBaseline,
  previewSync,
  recoverSyncTransactions,
} from "../src/sync.ts";
import type { StoredPreview, SyncJournal } from "../src/sync-contract.ts";
import { previewBinding } from "../src/sync-preview.ts";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);

function file(pathname: string, hash: string): SyncFile {
  return { path: pathname, kind: "file", sha256: hash, size: 1, mode: 0o644 };
}

async function repo(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporary.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

async function fixture() {
  const source = await repo("container-lab-source-");
  const target = await repo("container-lab-target-");
  const stateRoot = await mkdtemp(
    path.join(os.tmpdir(), "container-lab-state-"),
  );
  temporary.push(stateRoot);
  for (const root of [source, target]) {
    await writeFile(path.join(root, "file.txt"), "base\n");
    execFileSync("git", ["-C", root, "add", "file.txt"]);
  }
  const identity = { stateRoot, labId: "lab-1" };
  await initializeSyncBaseline(identity, target);
  return { source, target, ...identity };
}

type SyncFixture = Awaited<ReturnType<typeof fixture>>;
type CrashPoint =
  | "after-directory-created"
  | "before-publish"
  | "after-publish"
  | "after-journal"
  | "after-baseline";

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function firstBackup(journal: SyncJournal) {
  return required(journal.backups[0], "journal backup");
}

async function crashApply(
  state: SyncFixture,
  point: CrashPoint = "after-publish",
): Promise<{ journal: SyncJournal; journalPath: string }> {
  const preview = await previewSync({
    ...state,
    direction: "push",
    sourceRoot: state.source,
    targetRoot: state.target,
  });
  const modulePath = path.join(import.meta.dir, "../src/sync-apply.ts");
  const script = `
    const { applySyncWithHooks } = await import(${JSON.stringify(modulePath)});
    const options = JSON.parse(process.env.SYNC_CRASH_OPTIONS);
    const point = process.env.SYNC_CRASH_POINT;
    const crash = () => process.exit(86);
    await applySyncWithHooks(
      { ...options, idleGuard: () => true },
      {
        ...(point === "after-directory-created" ? { afterDirectoryCreated: crash } : {}),
        ...(point === "before-publish" ? { beforePathPublished: crash } : {}),
        ...(point === "after-publish" ? { afterPathPublished: crash } : {}),
        ...(point === "after-journal" ? { afterJournalApplied: crash } : {}),
        ...(point === "after-baseline" ? { afterBaselinePublished: crash } : {}),
      },
    );
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      SYNC_CRASH_OPTIONS: JSON.stringify({
        ...state,
        direction: "push",
        sourceRoot: state.source,
        targetRoot: state.target,
        token: preview.token,
      }),
      SYNC_CRASH_POINT: point,
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
  const journalDirectory = path.join(
    state.stateRoot,
    "sync",
    state.labId,
    "journals",
  );
  const journals = await readdir(journalDirectory);
  if (journals.length !== 1) {
    throw new Error(`Expected one crash journal, found ${journals.length}`);
  }
  const journalPath = path.join(
    journalDirectory,
    required(journals[0], "crash journal"),
  );
  return {
    journalPath,
    journal: JSON.parse(await readFile(journalPath, "utf8")) as SyncJournal,
  };
}

type ParentReplacement = "removed" | "recreated" | "symlink";

async function replaceNestedParent(
  state: SyncFixture,
  replacement: ParentReplacement,
): Promise<string> {
  const parent = path.join(state.target, "nested");
  await rm(parent, { recursive: true });
  if (replacement === "recreated") {
    await mkdir(parent);
  }
  if (replacement === "symlink") {
    const outside = await mkdtemp(path.join(os.tmpdir(), "sync-outside-"));
    temporary.push(outside);
    await writeFile(path.join(outside, "sentinel.txt"), "keep\n");
    await symlink(outside, parent);
  }
  return parent;
}

describe("three-way comparison", () => {
  test("emits source-only updates and deletes", () => {
    const baseline = { a: file("a", "1"), b: file("b", "1") };
    const result = compareManifests(baseline, { a: file("a", "2") }, baseline);
    expect(result.changes.map(({ path, action }) => [path, action])).toEqual([
      ["a", "upsert"],
      ["b", "delete"],
    ]);
    expect(result.conflicts).toEqual([]);
  });

  test("reports divergent edits but leaves target-only edits alone", () => {
    const baselineB = file("b", "1");
    const baseline = { a: file("a", "1"), b: baselineB };
    const result = compareManifests(
      baseline,
      {
        a: file("a", "2"),
        b: baselineB,
      },
      { a: file("a", "3"), b: file("b", "2") },
    );
    expect(result.conflicts.map(({ path }) => path)).toEqual(["a"]);
    expect(result.changes).toEqual([]);
  });

  test("treats identical concurrent edits as synchronized and ignores target-only deletion", () => {
    const baselineB = file("b", "1");
    const baseline = { a: file("a", "1"), b: baselineB };
    const synchronizedSource = file("a", "2");
    const synchronizedTarget = file("a", "2");
    expect(synchronizedSource).not.toBe(synchronizedTarget);
    const result = compareManifests(
      baseline,
      { a: synchronizedSource, b: baselineB },
      { a: synchronizedTarget },
    );

    expect(result).toEqual({ changes: [], conflicts: [] });
  });
});

describe("guarded preview and apply", () => {
  test("applies content and mode, persists details, calls the idle guard, and consumes the token", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "updated\n");
    await chmod(path.join(state.source, "file.txt"), 0o755);
    let guarded = 0;
    const preview = await previewSync({
      ...state,
      direction: "push",
      sourceRoot: state.source,
      targetRoot: state.target,
    });
    const persisted = JSON.parse(
      await readFile(
        path.join(
          state.stateRoot,
          "sync",
          state.labId,
          "previews",
          `${preview.token}.json`,
        ),
        "utf8",
      ),
    );
    expect(persisted.changes).toHaveLength(1);

    expect(
      await applySync({
        ...state,
        direction: "push",
        sourceRoot: state.source,
        targetRoot: state.target,
        token: preview.token,
        idleGuard: () => {
          guarded++;
        },
      }),
    ).toEqual({ applied: 1 });
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "updated\n",
    );
    expect(guarded).toBe(2);
    await expect(
      applySync({
        ...state,
        direction: "push",
        sourceRoot: state.source,
        targetRoot: state.target,
        token: preview.token,
        idleGuard: () => true,
      }),
    ).rejects.toThrow("already-used");
  });

  test("previews and applies prototype-shaped tracked paths as ordinary records", async () => {
    const state = await fixture();
    const names = ["__proto__", "constructor", "prototype"];
    for (const root of [state.source, state.target]) {
      for (const name of names) {
        await writeFile(path.join(root, name), "base\n");
      }
      execFileSync("git", ["-C", root, "add", "--", ...names]);
    }
    await initializeSyncBaseline(state, state.target);
    for (const name of names) {
      await writeFile(path.join(state.source, name), `${name}\n`);
    }

    const preview = await previewSync({
      ...state,
      direction: "push",
      sourceRoot: state.source,
      targetRoot: state.target,
    });
    expect(preview.changes.map((change) => change.path)).toEqual(names);
    expect(
      await applySync({
        ...state,
        direction: "push",
        sourceRoot: state.source,
        targetRoot: state.target,
        token: preview.token,
        idleGuard: () => true,
      }),
    ).toEqual({ applied: 3 });

    for (const name of names) {
      expect(await readFile(path.join(state.target, name), "utf8")).toBe(
        `${name}\n`,
      );
    }
    const baseline = JSON.parse(
      await readFile(
        path.join(state.stateRoot, "sync", state.labId, "baseline.json"),
        "utf8",
      ),
    ) as { files: Record<string, unknown> };
    expect(
      Object.keys(baseline.files).filter((name) => names.includes(name)),
    ).toEqual(names);
    expect(Object.hasOwn(baseline.files, "__proto__")).toBe(true);
  });

  test("rejects conflicts", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    await writeFile(path.join(state.target, "file.txt"), "target\n");
    const preview = await previewSync({
      ...state,
      direction: "push",
      sourceRoot: state.source,
      targetRoot: state.target,
    });
    expect(preview.conflicts.map(({ path }) => path)).toEqual(["file.txt"]);
    await expect(
      applySync({
        ...state,
        direction: "push",
        sourceRoot: state.source,
        targetRoot: state.target,
        token: preview.token,
        idleGuard: () => true,
      }),
    ).rejects.toThrow("contains conflicts");
  });

  test("applies deletions and symlinks without following them", async () => {
    const state = await fixture();
    await rm(path.join(state.source, "file.txt"));
    await symlink("destination", path.join(state.source, "link"));
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };
    const preview = await previewSync(base);
    expect(preview.changes.map(({ path, action }) => [path, action])).toEqual([
      ["file.txt", "delete"],
      ["link", "upsert"],
    ]);
    await applySync({ ...base, token: preview.token, idleGuard: () => true });
    expect(
      (await lstat(path.join(state.target, "link"))).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(path.join(state.target, "link"))).toBe("destination");
    await expect(
      lstat(path.join(state.target, "file.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a target parent changed into a symlink after preview", async () => {
    const state = await fixture();
    for (const root of [state.source, state.target]) {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "nested", "file.txt"), "base\n");
      execFileSync("git", ["-C", root, "add", "nested/file.txt"]);
    }
    await initializeSyncBaseline(state, state.target);
    await writeFile(path.join(state.source, "nested", "file.txt"), "source\n");
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };
    const preview = await previewSync(base);
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "container-lab-outside-"),
    );
    temporary.push(outside);
    await rm(path.join(state.target, "nested"), { recursive: true });
    await symlink(outside, path.join(state.target, "nested"));
    await expect(
      applySync({ ...base, token: preview.token, idleGuard: () => true }),
    ).rejects.toThrow("Unsafe synchronization parent");
  });

  test("rejects stale, expired, direction-mismatched, lab-mismatched, and busy applies", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };

    const mismatch = await previewSync(base);
    await expect(
      applySync({
        ...base,
        direction: "pull",
        token: mismatch.token,
        idleGuard: () => true,
      }),
    ).rejects.toThrow("does not match");
    await expect(
      applySync({
        ...base,
        labId: "other",
        token: mismatch.token,
        idleGuard: () => true,
      }),
    ).rejects.toThrow("Unknown");

    const stale = await previewSync(base);
    await writeFile(path.join(state.source, "file.txt"), "changed again\n");
    await expect(
      applySync({ ...base, token: stale.token, idleGuard: () => true }),
    ).rejects.toThrow("is stale");

    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const expired = await previewSync({ ...base, now: new Date(0) });
    await expect(
      applySync({
        ...base,
        token: expired.token,
        now: new Date(300_001),
        idleGuard: () => true,
      }),
    ).rejects.toThrow("expired");

    const busy = await previewSync(base);
    await expect(
      applySync({ ...base, token: busy.token, idleGuard: () => false }),
    ).rejects.toThrow("idle lab");
  });

  test("does not issue an apply token for a preview too large to expose", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    await expect(
      previewSync({
        ...state,
        direction: "push",
        sourceRoot: state.source,
        targetRoot: state.target,
        maxEntries: 0,
      }),
    ).rejects.toThrow("reduce the change set");
  });

  test("rejects a target edit racing with staging and preserves it", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };
    const preview = await previewSync(base);
    let guards = 0;
    await expect(
      applySync({
        ...base,
        token: preview.token,
        idleGuard: async () => {
          guards++;
          if (guards === 1) {
            await writeFile(
              path.join(state.target, "file.txt"),
              "racing target\n",
            );
          }
        },
      }),
    ).rejects.toThrow("target changed after preview");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "racing target\n",
    );
    const syncRoot = path.join(state.stateRoot, "sync", state.labId);
    expect(await readdir(path.join(syncRoot, "journals"))).toEqual([]);
    expect(await readdir(path.join(syncRoot, "backups"))).toEqual([]);
    expect(await readdir(path.join(syncRoot, "used"))).toEqual([
      `${preview.token}.json`,
    ]);
  });

  test("runs the final idle guard before entry validation and preserves a racing target edit", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };
    const preview = await previewSync(base);
    let guards = 0;

    await expect(
      applySync({
        ...base,
        token: preview.token,
        idleGuard: async () => {
          guards++;
          if (guards === 2) {
            await writeFile(
              path.join(state.target, "file.txt"),
              "late racing target\n",
            );
          }
        },
      }),
    ).rejects.toThrow("target changed after preview");

    expect(guards).toBe(2);
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "late racing target\n",
    );
  });

  test("rejects a rebound injected upsert before target mutation", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };
    const preview = await previewSync(base);
    const previewPath = path.join(
      state.stateRoot,
      "sync",
      state.labId,
      "previews",
      `${preview.token}.json`,
    );
    const stored = JSON.parse(
      await readFile(previewPath, "utf8"),
    ) as StoredPreview;
    const firstChange = required(stored.changes[0], "preview change");
    const injected = {
      ...required(firstChange.file, "preview file"),
      path: "injected.txt",
    };
    stored.changes = [
      ...stored.changes,
      { path: "injected.txt", action: "upsert", file: injected },
    ];
    stored.expectedTargets["injected.txt"] = null;
    stored.binding = previewBinding(stored);
    await writeFile(previewPath, JSON.stringify(stored));

    await expect(
      applySync({ ...base, token: preview.token, idleGuard: () => true }),
    ).rejects.toThrow("semantic payload is invalid");
    await expect(
      lstat(path.join(state.target, "injected.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "base\n",
    );
  });

  test("strictly rejects unknown and duplicate stored preview fields", async () => {
    for (const tamper of ["unknown", "duplicate"] as const) {
      const state = await fixture();
      await writeFile(path.join(state.source, "file.txt"), "source\n");
      const base = {
        ...state,
        direction: "push" as const,
        sourceRoot: state.source,
        targetRoot: state.target,
      };
      const preview = await previewSync(base);
      const previewPath = path.join(
        state.stateRoot,
        "sync",
        state.labId,
        "previews",
        `${preview.token}.json`,
      );
      const stored = JSON.parse(
        await readFile(previewPath, "utf8"),
      ) as StoredPreview & { unexpected?: boolean };
      if (tamper === "unknown") {
        stored.unexpected = true;
      } else {
        stored.changes.push(
          structuredClone(required(stored.changes[0], "preview change")),
        );
      }
      await writeFile(previewPath, JSON.stringify(stored));

      await expect(
        applySync({ ...base, token: preview.token, idleGuard: () => true }),
      ).rejects.toThrow("Invalid");
      expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
        "base\n",
      );
    }
  });

  test("rejects a symlink-swapped stored preview before mutation", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };
    const preview = await previewSync(base);
    const previewPath = path.join(
      state.stateRoot,
      "sync",
      state.labId,
      "previews",
      `${preview.token}.json`,
    );
    const external = path.join(state.stateRoot, "external-preview.json");
    await writeFile(external, await readFile(previewPath));
    await rm(previewPath);
    await symlink(external, previewPath);

    await expect(
      applySync({ ...base, token: preview.token, idleGuard: () => true }),
    ).rejects.toThrow("Unsafe synchronization state file");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "base\n",
    );
  });

  test("consumes a token but removes all preparation artifacts after a source race", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };
    const preview = await previewSync(base);
    await expect(
      applySync({
        ...base,
        token: preview.token,
        idleGuard: async () => {
          await writeFile(
            path.join(state.source, "file.txt"),
            "racing source\n",
          );
        },
      }),
    ).rejects.toThrow("source changed");

    const syncRoot = path.join(state.stateRoot, "sync", state.labId);
    expect(await readdir(path.join(syncRoot, "journals"))).toEqual([]);
    expect(await readdir(path.join(syncRoot, "backups"))).toEqual([]);
    expect(await readdir(path.join(syncRoot, "previews"))).toEqual([]);
    expect(await readdir(path.join(syncRoot, "used"))).toEqual([
      `${preview.token}.json`,
    ]);
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "base\n",
    );
  });

  test("does not claim a token when the first idle guard refuses apply", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };
    const preview = await previewSync(base);
    await expect(
      applySync({ ...base, token: preview.token, idleGuard: () => false }),
    ).rejects.toThrow("idle lab");
    await expect(
      applySync({ ...base, token: preview.token, idleGuard: () => true }),
    ).resolves.toEqual({ applied: 1 });
  });

  test("preserves a target directory created during the final idle guard", async () => {
    const state = await fixture();
    await mkdir(path.join(state.source, "nested"));
    await writeFile(path.join(state.source, "nested", "new.txt"), "new\n");
    execFileSync("git", ["-C", state.source, "add", "nested/new.txt"]);
    const base = {
      ...state,
      direction: "push" as const,
      sourceRoot: state.source,
      targetRoot: state.target,
    };
    const preview = await previewSync(base);
    let guards = 0;
    await expect(
      applySync({
        ...base,
        token: preview.token,
        idleGuard: async () => {
          guards++;
          if (guards === 2) {
            await mkdir(path.join(state.target, "nested"));
          }
        },
      }),
    ).rejects.toThrow("unverified target directory preserved");
    expect((await lstat(path.join(state.target, "nested"))).isDirectory()).toBe(
      true,
    );
  });
});

describe("transaction recovery", () => {
  test("rolls back a published deletion from its durable backup", async () => {
    const state = await fixture();
    for (const root of [state.source, state.target]) {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "nested", "delete.txt"), "base\n");
      execFileSync("git", ["-C", root, "add", "nested/delete.txt"]);
    }
    await initializeSyncBaseline(state, state.target);
    await rm(path.join(state.source, "nested", "delete.txt"));
    const crash = await crashApply(state);
    expect(
      crash.journal.deleteParentDirectories.map((entry) => entry.path),
    ).toEqual(["nested"]);
    await expect(
      lstat(path.join(state.target, "nested", "delete.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(
      await recoverSyncTransactions({
        ...state,
        allowedTargetRoots: [state.target],
      }),
    ).toBe(1);
    expect(
      await readFile(path.join(state.target, "nested", "delete.txt"), "utf8"),
    ).toBe("base\n");
  });

  for (const replacement of ["removed", "recreated", "symlink"] as const) {
    test(`retains a nested deletion journal when its parent is ${replacement}`, async () => {
      const state = await fixture();
      for (const root of [state.source, state.target]) {
        await mkdir(path.join(root, "nested"));
        await writeFile(path.join(root, "nested", "delete.txt"), "base\n");
        execFileSync("git", ["-C", root, "add", "nested/delete.txt"]);
      }
      await initializeSyncBaseline(state, state.target);
      await rm(path.join(state.source, "nested", "delete.txt"));
      const crash = await crashApply(state);
      const parent = await replaceNestedParent(state, replacement);

      await expect(
        recoverSyncTransactions({
          ...state,
          allowedTargetRoots: [state.target],
        }),
      ).rejects.toThrow("recovery conflict at nested");
      expect((await lstat(crash.journalPath)).isFile()).toBe(true);
      if (replacement === "removed") {
        await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
      } else if (replacement === "recreated") {
        expect((await readdir(parent)).length).toBe(0);
      } else {
        expect((await lstat(parent)).isSymbolicLink()).toBe(true);
        expect(await readFile(path.join(parent, "sentinel.txt"), "utf8")).toBe(
          "keep\n",
        );
      }
    });
  }

  test("removes journal-owned parent directories after a pre-rename crash", async () => {
    const state = await fixture();
    await mkdir(path.join(state.source, "nested", "deep"), { recursive: true });
    await writeFile(
      path.join(state.source, "nested", "deep", "new.txt"),
      "new\n",
    );
    execFileSync("git", ["-C", state.source, "add", "nested/deep/new.txt"]);
    const crash = await crashApply(state, "before-publish");
    expect(crash.journal.createdDirectories.map((entry) => entry.path)).toEqual(
      ["nested", "nested/deep"],
    );
    expect((await lstat(path.join(state.target, "nested"))).isDirectory()).toBe(
      true,
    );

    expect(
      await recoverSyncTransactions({
        ...state,
        allowedTargetRoots: [state.target],
      }),
    ).toBe(1);
    await expect(
      lstat(path.join(state.target, "nested")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retains a pre-publication journal when a created parent is replaced", async () => {
    const state = await fixture();
    await mkdir(path.join(state.source, "nested", "deep"), { recursive: true });
    await writeFile(
      path.join(state.source, "nested", "deep", "new.txt"),
      "new\n",
    );
    execFileSync("git", ["-C", state.source, "add", "nested/deep/new.txt"]);
    const crash = await crashApply(state, "before-publish");
    const parent = path.join(state.target, "nested");
    await rm(parent, { recursive: true });
    await mkdir(parent);

    await expect(
      recoverSyncTransactions({
        ...state,
        allowedTargetRoots: [state.target],
      }),
    ).rejects.toThrow("recovery conflict at nested");
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);
    expect(await readdir(parent)).toEqual([]);
  });

  test("retains an unverified directory created before its identity was journaled", async () => {
    const state = await fixture();
    await mkdir(path.join(state.source, "nested"));
    await writeFile(path.join(state.source, "nested", "new.txt"), "new\n");
    execFileSync("git", ["-C", state.source, "add", "nested/new.txt"]);
    const crash = await crashApply(state, "after-directory-created");
    expect(crash.journal.creatingDirectory).toBe("nested");
    expect(crash.journal.createdDirectories).toEqual([]);

    await expect(
      recoverSyncTransactions({
        ...state,
        allowedTargetRoots: [state.target],
      }),
    ).rejects.toThrow("unverified target directory preserved");
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);
    expect((await lstat(path.join(state.target, "nested"))).isDirectory()).toBe(
      true,
    );
  });

  test("removes a crash-created publication artifact while retaining the original target", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "plugin write\n");
    const crash = await crashApply(state, "before-publish");
    const publication = crash.journal.backups[0]?.publication;
    expect(publication).toBeString();
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "base\n",
    );
    expect((await lstat(publication as string)).isFile()).toBe(true);

    expect(
      await recoverSyncTransactions({
        ...state,
        allowedTargetRoots: [state.target],
      }),
    ).toBe(1);
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "base\n",
    );
    await expect(lstat(publication as string)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rolls back an atomically published target using the production journal descriptor", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "plugin write\n");
    const crash = await crashApply(state);
    expect(crash.journal.state).toBe("prepared");
    expect(crash.journal.mutatedPaths).toEqual(["file.txt"]);
    expect(crash.journal.appliedStates["file.txt"]).toEqual(
      crash.journal.newBaseline.files["file.txt"],
    );
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "plugin write\n",
    );

    expect(
      await recoverSyncTransactions({
        ...state,
        allowedTargetRoots: [state.target],
      }),
    ).toBe(1);
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "base\n",
    );
  });

  test("finishes baseline publication after all targets were durably applied", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "plugin write\n");
    const crash = await crashApply(state, "after-journal");
    expect(crash.journal.state).toBe("applied");
    const syncRoot = path.join(state.stateRoot, "sync", state.labId);
    expect(
      JSON.parse(await readFile(path.join(syncRoot, "baseline.json"), "utf8")),
    ).not.toEqual(crash.journal.newBaseline);
    expect(
      await recoverSyncTransactions({
        ...state,
        allowedTargetRoots: [state.target],
      }),
    ).toBe(1);
    expect(
      JSON.parse(await readFile(path.join(syncRoot, "baseline.json"), "utf8")),
    ).toEqual(crash.journal.newBaseline);
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "plugin write\n",
    );
  });

  test("refuses baseline publication after an applied-state user divergence", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "plugin write\n");
    const crash = await crashApply(state, "after-journal");
    const syncRoot = path.join(state.stateRoot, "sync", state.labId);
    const baselineBefore = await readFile(
      path.join(syncRoot, "baseline.json"),
      "utf8",
    );
    await writeFile(path.join(state.target, "file.txt"), "user after apply\n");

    await expect(
      recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] }),
    ).rejects.toThrow("recovery conflict");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "user after apply\n",
    );
    expect(await readFile(path.join(syncRoot, "baseline.json"), "utf8")).toBe(
      baselineBefore,
    );
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);
  });

  test("treats a durable baseline as committed and preserves later target edits", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "plugin write\n");
    const crash = await crashApply(state, "after-baseline");
    await writeFile(path.join(state.target, "file.txt"), "user after commit\n");

    expect(
      await recoverSyncTransactions({
        ...state,
        allowedTargetRoots: [state.target],
      }),
    ).toBe(1);
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "user after commit\n",
    );
    await expect(lstat(crash.journalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("preserves a divergent edit made after publication and retains recovery state", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "plugin write\n");
    const crash = await crashApply(state);
    await writeFile(path.join(state.target, "file.txt"), "user after crash\n");
    await expect(
      recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] }),
    ).rejects.toThrow("recovery conflict");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "user after crash\n",
    );
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);
  });

  test("rejects journal roots and baseline paths outside the lab allowlist", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "plugin write\n");
    const crash = await crashApply(state);
    const syncRoot = path.join(state.stateRoot, "sync", state.labId);
    const outside = await repo("container-lab-unowned-");
    const ownedTarget = crash.journal.targetRoot;
    crash.journal.targetRoot = outside;
    await writeFile(crash.journalPath, JSON.stringify(crash.journal));
    await expect(
      recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] }),
    ).rejects.toThrow("not owned");

    crash.journal.targetRoot = ownedTarget;
    crash.journal.baselinePath = path.join(
      state.stateRoot,
      "other-baseline.json",
    );
    await writeFile(crash.journalPath, JSON.stringify(crash.journal));
    await expect(
      recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] }),
    ).rejects.toThrow("does not belong");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "plugin write\n",
    );
    expect(await readdir(path.join(syncRoot, "journals"))).toHaveLength(1);
  });

  test("rejects malformed journal records and external backup injection before writes", async () => {
    const cases: Array<{
      name: string;
      tamper: (journal: SyncJournal, external: string) => void;
    }> = [
      {
        name: "unknown field",
        tamper: (journal) => {
          (journal as unknown as Record<string, unknown>)["unexpected"] = true;
        },
      },
      {
        name: "external backup",
        tamper: (journal, external) => {
          firstBackup(journal).backup = external;
        },
      },
      {
        name: "missing backup",
        tamper: (journal) => {
          journal.backups = [];
        },
      },
      {
        name: "duplicate backup",
        tamper: (journal) => {
          journal.backups.push(structuredClone(firstBackup(journal)));
        },
      },
      {
        name: "external publication",
        tamper: (journal, external) => {
          firstBackup(journal).publication = external;
        },
      },
      {
        name: "altered backup descriptor",
        tamper: (journal) => {
          required(
            firstBackup(journal).original ?? undefined,
            "backup original",
          ).sha256 = "0".repeat(64);
        },
      },
      {
        name: "altered baseline provenance",
        tamper: (journal) => {
          required(
            journal.newBaseline.files["file.txt"],
            "baseline file",
          ).sha256 = "0".repeat(64);
        },
      },
    ];

    for (const entry of cases) {
      const state = await fixture();
      await writeFile(path.join(state.source, "file.txt"), "plugin write\n");
      const crash = await crashApply(state);
      const external = path.join(state.stateRoot, `${entry.name}.sentinel`);
      await writeFile(external, "sentinel\n");
      entry.tamper(crash.journal, external);
      await writeFile(crash.journalPath, JSON.stringify(crash.journal));

      await expect(
        recoverSyncTransactions({
          ...state,
          allowedTargetRoots: [state.target],
        }),
      ).rejects.toThrow("Invalid");
      expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
        "plugin write\n",
      );
      expect(await readFile(external, "utf8")).toBe("sentinel\n");
      expect((await lstat(crash.journalPath)).isFile()).toBe(true);
    }
  });

  test("rejects swapped production backup records before recovery writes", async () => {
    const state = await fixture();
    for (const root of [state.source, state.target]) {
      await writeFile(path.join(root, "second.txt"), "base second\n");
      execFileSync("git", ["-C", root, "add", "second.txt"]);
    }
    await initializeSyncBaseline(state, state.target);
    await writeFile(path.join(state.source, "file.txt"), "plugin first\n");
    await writeFile(path.join(state.source, "second.txt"), "plugin second\n");
    const crash = await crashApply(state);
    expect(crash.journal.backups).toHaveLength(2);
    crash.journal.backups.reverse();
    await writeFile(crash.journalPath, JSON.stringify(crash.journal));

    await expect(
      recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] }),
    ).rejects.toThrow("Invalid journal backup paths");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "plugin first\n",
    );
    expect(await readFile(path.join(state.target, "second.txt"), "utf8")).toBe(
      "base second\n",
    );
  });

  test("rejects a symlink-swapped backup directory before target writes", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "plugin write\n");
    const crash = await crashApply(state);
    const backup = required(firstBackup(crash.journal).backup, "backup path");
    const backupDirectory = path.dirname(backup);
    const external = await mkdtemp(
      path.join(os.tmpdir(), "container-lab-external-backup-"),
    );
    temporary.push(external);
    await rm(backupDirectory, { recursive: true });
    await symlink(external, backupDirectory);

    await expect(
      recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] }),
    ).rejects.toThrow("Invalid synchronization backup directory");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "plugin write\n",
    );
    expect(await readdir(external)).toEqual([]);
  });
});
