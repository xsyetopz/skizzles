// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { PackagingError } from "../../../src/plugin/api.ts";
import {
  inspectTarget,
  transactionLockPath,
} from "../../../src/plugin/destination/path.ts";
import { replaceDirectoryTransaction } from "../../../src/plugin/destination/transaction.ts";
import { createTestWorkspace } from "../fixture.ts";

const { cleanup, temporaryRoot: allocateTemporaryRoot } = createTestWorkspace();
afterEach(cleanup);

describe("plugin destination transaction adversarial recovery", () => {
  it("restores a destination replacement swapped after final validation", async () => {
    const parent = await temporaryRoot("skizzles-swap-after-validation-");
    const destination = join(parent, "plugin");
    const displaced = join(parent, "displaced-original");
    await writeTree(destination, "old", "old\n");

    await expect(
      replaceDirectoryTransaction(
        destination,
        (stage) => writeFile(join(stage, "new"), "new\n"),
        {
          checkpoint: async (point) => {
            if (point !== "backup-validated") return;
            await rename(destination, displaced);
            await writeTree(destination, "replacement", "replacement\n");
          },
        },
      ),
    ).rejects.toThrow(
      "Plugin staging destination changed during the transaction.",
    );
    expect(await readFile(join(destination, "replacement"), "utf8")).toBe(
      "replacement\n",
    );
    expect(await readFile(join(displaced, "old"), "utf8")).toBe("old\n");
  });

  it("retains a deterministic recovery journal when rollback is blocked", async () => {
    const parent = await temporaryRoot("skizzles-incomplete-rollback-");
    const destination = join(parent, "plugin");
    await writeTree(destination, "old", "old\n");

    await expect(
      replaceDirectoryTransaction(
        destination,
        (stage) => writeFile(join(stage, "new"), "new\n"),
        {
          checkpoint: async (point) => {
            if (point !== "backup-renamed") return;
            await writeTree(destination, "replacement", "replacement\n");
            throw new Error("block rollback");
          },
        },
      ),
    ).rejects.toThrow("rollback could not complete safely");
    const retained = await transactionArtifacts(parent);
    expect(retained.some((name) => name.endsWith(".lock"))).toBe(true);
    expect(retained.some((name) => name.includes("-backup-"))).toBe(true);
    expect(await readFile(join(destination, "replacement"), "utf8")).toBe(
      "replacement\n",
    );

    await rm(destination, { recursive: true });
    expect(await observeRecovered(destination)).toBe("old");
    expect(await readFile(join(destination, "old"), "utf8")).toBe("old\n");
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("recovers valid temporary owner and journal publications", async () => {
    for (const [point, expected] of [
      ..."claim-helper-ready claim-temp-ready claim-published lock-created"
        .split(" ")
        .map((point) => [point, "old"] as const),
      ["owner-ready", "old"],
      ["initial-journal-ready", "old"],
      ["stage-journal-ready", "old"],
      ["backup-journal-ready", "old"],
      ["committed-journal-ready", "new"],
      ..."claim-release-ready claim-released claim-helper-stopped backup-disposal-ready backup-disposal-renamed backup-disposal-remove backup-disposal-partial lock-disposal-ready lock-disposal-renamed lock-disposal-remove lock-disposal-journal lock-disposal-owner"
        .split(" ")
        .map((point) => [point, "new"] as const),
    ] as const) {
      const parent = await temporaryRoot(`skizzles-publication-${point}-`);
      const destination = join(parent, "plugin");
      await writeTree(destination, "old", "old\n");
      expect(crashAt(destination, point)).toBe(73);
      // biome-ignore lint/performance/noAwaitInLoops: each publication crash is recovered before the next isolated case.
      expect(await observeRecovered(destination)).toBe(expected);
      // biome-ignore lint/performance/noAwaitInLoops: artifact cleanup is part of each isolated recovery case.
      expect(await transactionArtifacts(parent)).toEqual([]);
    }
  }, 20_000);

  it("rejects escaped duplicate owner keys before deriving artifact paths", async () => {
    const parent = await temporaryRoot("skizzles-invalid-owner-token-");
    const destination = join(parent, "plugin");
    const outside = join(parent, "outside-marker");
    await writeFile(outside, "preserved\n");
    const lock = transactionLockPath(await inspectTarget(destination));
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      join(lock, "owner.json"),
      '{"version":2,"controllerPid":999999999,"controllerStartIdentity":"dead","pid":999999999,"processStartIdentity":"dead","token":"../../outside-marker","\\u0074oken":"00000000-0000-4000-8000-000000000000"}\n',
    );
    await writeFile(
      join(lock, ".owner.json.00000000-0000-4000-8000-000000000000.tmp"),
      '{"version":2,"controllerPid":999999999,"controllerStartIdentity":"dead","pid":999999999,"processStartIdentity":"dead","token":"00000000-0000-4000-8000-000000000000"}\n',
    );

    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve()),
    ).rejects.toThrow("locked by another operation");
    expect(await readFile(outside, "utf8")).toBe("preserved\n");

    await rm(lock, { recursive: true });
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      join(lock, "owner.json"),
      '{"version":2,"controllerPid":999999999,"controllerStartIdentity":"dead","pid":999999999,"processStartIdentity":"dead","token":"00000000-0000-4000-8000-000000000000"}\n',
    );
    await writeFile(
      join(lock, "journal.json"),
      '{"version":2,"state":"committed","\\u0073tate":"active","original":{"present":false}}\n',
    );
    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve()),
    ).rejects.toThrow("locked by another operation");
  });

  it("restores a replacement swapped after cleanup identity validation", async () => {
    const parent = await temporaryRoot("skizzles-cleanup-swap-");
    const destination = join(parent, "plugin");
    const displaced = join(parent, "owned-lock");
    let lock = "";

    await expect(
      replaceDirectoryTransaction(
        destination,
        (stage) => writeFile(join(stage, "new"), "new\n"),
        {
          beforeLockCleanup: (path) => {
            lock = path;
          },
          beforeLockRemovalRename: async () => {
            await rename(lock, displaced);
            await writeTree(lock, "replacement", "replacement\n");
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(await readFile(join(lock, "replacement"), "utf8")).toBe(
      "replacement\n",
    );
    expect((await readdir(displaced)).sort()).toEqual([
      "journal.json",
      "owner.json",
    ]);
  });

  it("removes created ancestors when parent establishment itself fails", async () => {
    const parent = await temporaryRoot("skizzles-parent-establishment-");
    const created = join(parent, "new");
    await expect(
      replaceDirectoryTransaction(
        join(created, "nested/plugin"),
        () => Promise.resolve(),
        {
          afterParentCreated: () => {
            throw new Error("parent establishment interrupted");
          },
        },
      ),
    ).rejects.toThrow(
      "Plugin staging destination ancestors must be existing real directories.",
    );
    expect(await Bun.file(created).exists()).toBe(false);
  });

  it("supersedes a committed temp journal after incomplete rollback", async () => {
    const parent = await temporaryRoot("skizzles-committed-temp-rollback-");
    const destination = join(parent, "plugin");
    const displacedNew = join(parent, "displaced-new");
    await writeTree(destination, "old", "old\n");

    await expect(
      replaceDirectoryTransaction(
        destination,
        (stage) => writeFile(join(stage, "new"), "new\n"),
        {
          checkpoint: async (point) => {
            if (point !== "committed-journal-ready") return;
            await rename(destination, displacedNew);
            await writeTree(destination, "replacement", "replacement\n");
            throw new Error("block rollback after committed temp");
          },
        },
      ),
    ).rejects.toThrow("rollback could not complete safely");
    await rm(destination, { recursive: true });
    expect(await observeRecovered(destination)).toBe("old");
    expect(await readFile(join(destination, "old"), "utf8")).toBe("old\n");
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  return allocateTemporaryRoot(prefix.replace(/-$/u, ""));
}

async function writeTree(
  root: string,
  name: string,
  contents: string,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, name), contents);
}

async function transactionArtifacts(parent: string): Promise<string[]> {
  return (await readdir(parent))
    .filter(
      (name) =>
        name.startsWith(".skizzles-package-") &&
        !name.includes(".recovery-highwater-"),
    )
    .sort();
}

function crashAt(destination: string, checkpoint: string): number {
  const module = resolve(
    import.meta.dir,
    "../../../src/plugin/destination/transaction.ts",
  );
  const source = `import { rm } from "node:fs/promises"; import { replaceDirectoryTransaction } from ${JSON.stringify(module)}; await replaceDirectoryTransaction(process.env.DEST, async (stage) => Bun.write(stage + "/new", "new\\n"), { checkpoint: async (point, path) => { if (process.env.POINT === "backup-disposal-partial" && point === "backup-disposal-remove") { await rm(path + "/previous/old"); process.exit(73); } if (point === process.env.POINT) process.exit(73); } });`;
  return Bun.spawnSync([process.execPath, "-e", source], {
    env: { ...process.env, DEST: destination, POINT: checkpoint },
    stderr: "pipe",
    stdout: "pipe",
  }).exitCode;
}

async function observeRecovered(
  destination: string,
): Promise<"missing" | "new" | "old"> {
  let observed: "missing" | "new" | "old" = "missing";
  const stop = new PackagingError("stop after recovery observation");
  try {
    await replaceDirectoryTransaction(destination, async () => {
      if (await Bun.file(join(destination, "old")).exists()) observed = "old";
      if (await Bun.file(join(destination, "new")).exists()) observed = "new";
      throw stop;
    });
  } catch (error) {
    if (error !== stop) throw error;
  }
  return observed;
}
