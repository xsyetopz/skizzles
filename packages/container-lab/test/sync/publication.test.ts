import { afterEach, describe, expect, it } from "bun:test";
import { applySyncWithHooks } from "../../src/sync/apply.ts";
import {
  createSyncFixtureScope,
  execFileSync,
  initializeSyncBaseline,
  lstat,
  mkdir,
  mkdtemp,
  os,
  path,
  previewSync,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "./support.ts";

const fixtures = createSyncFixtureScope();
const { fixture, trackTemporaryPath } = fixtures;
afterEach(fixtures.cleanup);

describe("publication boundary conflicts", () => {
  it("preserves a file edit made immediately before upsert publication", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "incoming\n");
    const preview = await previewSync({
      ...state,
      direction: "push",
      sourceRoot: state.source,
      targetRoot: state.target,
    });

    await expect(
      applySyncWithHooks(
        {
          ...state,
          direction: "push",
          sourceRoot: state.source,
          targetRoot: state.target,
          token: preview.token,
          idleGuard: () => true,
        },
        {
          beforePathPublished: async () => {
            await writeFile(
              path.join(state.target, "file.txt"),
              "concurrent-host-edit\n",
            );
          },
        },
      ),
    ).rejects.toThrow("recovery state was retained");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "concurrent-host-edit\n",
    );
    expect(
      await readdir(
        path.join(state.stateRoot, "sync", state.labId, "journals"),
      ),
    ).toHaveLength(1);
  });

  it("preserves a symlink replacement made immediately before publication", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "incoming\n");
    const outside = trackTemporaryPath(
      await mkdtemp(path.join(os.tmpdir(), "sync-publication-outside-")),
    );
    const external = path.join(outside, "sentinel.txt");
    await writeFile(external, "keep\n");
    const preview = await previewSync({
      ...state,
      direction: "push",
      sourceRoot: state.source,
      targetRoot: state.target,
    });

    await expect(
      applySyncWithHooks(
        {
          ...state,
          direction: "push",
          sourceRoot: state.source,
          targetRoot: state.target,
          token: preview.token,
          idleGuard: () => true,
        },
        {
          beforePathPublished: async () => {
            const target = path.join(state.target, "file.txt");
            await rm(target);
            await symlink(external, target);
          },
        },
      ),
    ).rejects.toThrow("recovery state was retained");
    expect(
      (await lstat(path.join(state.target, "file.txt"))).isSymbolicLink(),
    ).toBe(true);
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "keep\n",
    );
    expect(
      await readdir(
        path.join(state.stateRoot, "sync", state.labId, "journals"),
      ),
    ).toHaveLength(1);
  });

  it("preserves a replacement created immediately before deletion", async () => {
    const state = await fixture();
    await rm(path.join(state.source, "file.txt"));
    const preview = await previewSync({
      ...state,
      direction: "push",
      sourceRoot: state.source,
      targetRoot: state.target,
    });

    await expect(
      applySyncWithHooks(
        {
          ...state,
          direction: "push",
          sourceRoot: state.source,
          targetRoot: state.target,
          token: preview.token,
          idleGuard: () => true,
        },
        {
          beforePathPublished: async () => {
            const target = path.join(state.target, "file.txt");
            await rm(target);
            await writeFile(target, "late-replacement\n");
          },
        },
      ),
    ).rejects.toThrow("recovery state was retained");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe(
      "late-replacement\n",
    );
    expect(
      await readdir(
        path.join(state.stateRoot, "sync", state.labId, "journals"),
      ),
    ).toHaveLength(1);
  });

  it("rejects a parent swap and cleans a successful rollback", async () => {
    const state = await fixture();
    for (const root of [state.source, state.target]) {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "nested", "file.txt"), "base\n");
      execFileSync("git", ["-C", root, "add", "nested/file.txt"]);
    }
    await initializeSyncBaseline(state, state.target);
    await writeFile(
      path.join(state.source, "nested", "file.txt"),
      "incoming\n",
    );
    const preview = await previewSync({
      ...state,
      direction: "push",
      sourceRoot: state.source,
      targetRoot: state.target,
    });

    await expect(
      applySyncWithHooks(
        {
          ...state,
          direction: "push",
          sourceRoot: state.source,
          targetRoot: state.target,
          token: preview.token,
          idleGuard: () => true,
        },
        {
          beforePathPublished: async () => {
            const parent = path.join(state.target, "nested");
            await rm(parent, { recursive: true });
            await mkdir(parent);
            await writeFile(path.join(parent, "file.txt"), "base\n");
            await writeFile(path.join(parent, "sentinel.txt"), "keep\n");
          },
        },
      ),
    ).rejects.toThrow(
      "Synchronization publication conflict at nested/file.txt; target preserved",
    );
    expect(
      await readFile(path.join(state.target, "nested", "sentinel.txt"), "utf8"),
    ).toBe("keep\n");
    const journalDirectory = path.join(
      state.stateRoot,
      "sync",
      state.labId,
      "journals",
    );
    const journals = await readdir(journalDirectory);
    expect(journals).toEqual([]);
    expect(
      await readdir(path.join(state.stateRoot, "sync", state.labId, "backups")),
    ).toEqual([]);
    expect(
      await readFile(path.join(state.target, "nested", "file.txt"), "utf8"),
    ).toBe("base\n");
    expect(
      await readFile(path.join(state.target, "nested", "sentinel.txt"), "utf8"),
    ).toBe("keep\n");
  });
});
