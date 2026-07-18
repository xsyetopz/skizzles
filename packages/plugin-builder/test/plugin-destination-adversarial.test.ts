// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  deserialize,
  matches,
  parseJournal,
  serialized,
} from "../src/plugin/destination-parent.ts";
import {
  inspectTarget,
  transactionLockPath,
} from "../src/plugin/destination-path.ts";
import { replaceDirectoryTransaction } from "../src/plugin/destination-transaction.ts";
import { PackagingError } from "../src/plugin-package.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("plugin destination transaction adversarial recovery", () => {
  it("round-trips bigint identities without numeric narrowing", () => {
    const identity = {
      dev: 9_007_199_254_740_993n,
      ino: 18_446_744_073_709_551_615n,
    };
    const encoded = serialized(identity);
    expect(encoded).toEqual({
      dev: "9007199254740993",
      ino: String(identity.ino),
    });
    expect(deserialize(encoded)).toEqual(identity);
    expect(matches(identity, encoded)).toBe(true);
    expect(matches({ ...identity, ino: identity.ino - 1n }, encoded)).toBe(
      false,
    );
    expect(() =>
      parseJournal(
        {
          original: { identity: { dev: "01", ino: "2" }, present: true },
          state: "active",
          version: 1,
        },
        1,
      ),
    ).toThrow("invalid identity");
  });

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
      ["owner-ready", "old"],
      ["initial-journal-ready", "old"],
      ["stage-journal-ready", "old"],
      ["backup-journal-ready", "old"],
      ["committed-journal-ready", "new"],
    ] as const) {
      const parent = await temporaryRoot(`skizzles-publication-${point}-`);
      const destination = join(parent, "plugin");
      await writeTree(destination, "old", "old\n");
      expect(crashAt(destination, point)).toBe(73);
      // biome-ignore lint/performance/noAwaitInLoops: each publication crash is recovered before the next isolated case.
      expect(await observeRecovered(destination)).toBe(expected);
    }
  }, 20_000);

  it("rejects a traversal-shaped owner token before deriving artifact paths", async () => {
    const parent = await temporaryRoot("skizzles-invalid-owner-token-");
    const destination = join(parent, "plugin");
    const outside = join(parent, "outside-marker");
    await writeFile(outside, "preserved\n");
    const lock = transactionLockPath(await inspectTarget(destination));
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      join(lock, "owner.json"),
      `${JSON.stringify({ version: 1, pid: 999_999_999, processStartIdentity: "dead", token: "../../outside-marker" })}\n`,
    );

    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve()),
    ).rejects.toThrow("locked by another operation");
    expect(await readFile(outside, "utf8")).toBe("preserved\n");
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
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
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
    .filter((name) => name.startsWith(".skizzles-package-"))
    .sort();
}

function crashAt(destination: string, checkpoint: string): number {
  const module = resolve(
    import.meta.dir,
    "../src/plugin/destination-transaction.ts",
  );
  const source = `import { replaceDirectoryTransaction } from ${JSON.stringify(module)}; await replaceDirectoryTransaction(process.env.DEST, async (stage) => Bun.write(stage + "/new", "new\\n"), { checkpoint: (point) => { if (point === process.env.POINT) process.exit(73); } });`;
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
