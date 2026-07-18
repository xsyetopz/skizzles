// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, test } from "bun:test";
import type { StoredPreview } from "./support.ts";
import {
  applySync,
  chmod,
  execFileSync,
  fixture,
  initializeSyncBaseline,
  lstat,
  mkdir,
  mkdtemp,
  os,
  path,
  previewBinding,
  previewSync,
  readdir,
  readFile,
  readlink,
  required,
  rm,
  symlink,
  temporary,
  writeFile,
} from "./support.ts";

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
