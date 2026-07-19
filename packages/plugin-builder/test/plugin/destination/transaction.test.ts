// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { PackagingError, stagePlugin } from "../../../src/plugin/api.ts";
import {
  inspectTarget,
  transactionLockPath,
} from "../../../src/plugin/destination/path.ts";
import { replaceDirectoryTransaction } from "../../../src/plugin/destination/transaction.ts";
import { createTestWorkspace, write } from "../fixture.ts";

const PRIVATE_MODE = 0o700;
const PERMISSION_BITS = 0o777;
const ARTIFACT_PREFIX = ".skizzles-package-";
const PRESERVED_BYTES = Buffer.from(
  "\0\u0001\u0002\u007f\u0080\u00ff",
  "latin1",
);
const { cleanup, fixture, temporaryRoots } = createTestWorkspace();
afterEach(cleanup);

describe("plugin destination transactions", () => {
  it("preserves every existing byte when the final staged validator rejects", async () => {
    const root = await fixture();
    const destination = join(root, "existing-plugin");
    await mkdir(destination);
    await chmod(destination, 0o751);
    await writeFile(join(destination, "preserved.bin"), PRESERVED_BYTES);
    await write(root, "skills/example/late-stage.unknown", "neutral\n");
    const originalMode = (await stat(destination)).mode & PERMISSION_BITS;

    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "has no explicit language-policy surface classification",
    );

    expect(await readFile(join(destination, "preserved.bin"))).toEqual(
      PRESERVED_BYTES,
    );
    expect((await stat(destination)).mode & PERMISSION_BITS).toBe(originalMode);
    expect(
      await Bun.file(join(destination, ".codex-plugin/plugin.json")).exists(),
    ).toBe(false);
    expect(await transactionArtifacts(root)).toEqual([]);
  });

  it("restores the identity-backed backup when promotion is interrupted", async () => {
    const parent = await temporaryRoot("skizzles-stage-rollback-");
    const destination = join(parent, "plugin");
    await write(parent, "plugin/old.txt", "old bytes\n");

    await expect(
      replaceDirectoryTransaction(
        destination,
        async (privateRoot) => {
          await writeFile(join(privateRoot, "new.txt"), "new bytes\n");
        },
        {
          checkpoint: (point) => {
            if (point !== "backup-renamed") return;
            throw new Error("injected promotion failure");
          },
        },
      ),
    ).rejects.toEqual(
      new PackagingError(
        "Plugin staging promotion failed; the previous destination was restored.",
      ),
    );
    expect(await readFile(join(destination, "old.txt"), "utf8")).toBe(
      "old bytes\n",
    );
    expect(await Bun.file(join(destination, "new.txt")).exists()).toBe(false);
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("leaves an absent destination absent when construction fails after writes", async () => {
    const parent = await temporaryRoot("skizzles-stage-write-failure-");
    const destination = join(parent, "plugin");

    await expect(
      replaceDirectoryTransaction(destination, async (privateRoot) => {
        await writeFile(join(privateRoot, "partial.txt"), "partial\n");
        throw new PackagingError("injected staged validation failure");
      }),
    ).rejects.toEqual(new PackagingError("injected staged validation failure"));
    expect(await Bun.file(destination).exists()).toBe(false);
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("fails closed when the same destination is already being constructed", async () => {
    const parent = await temporaryRoot("skizzles-stage-concurrent-");
    const destination = join(parent, "plugin");
    await write(parent, "plugin/old.txt", "old\n");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let competingConstructionRan = false;
    const first = replaceDirectoryTransaction(
      destination,
      async (privateRoot) => {
        await writeFile(join(privateRoot, "winner.txt"), "winner\n");
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;

    await expect(
      replaceDirectoryTransaction(destination, () => {
        competingConstructionRan = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(
      "Plugin staging destination is locked by another operation.",
    );
    expect(competingConstructionRan).toBe(false);
    expect(await readFile(join(destination, "old.txt"), "utf8")).toBe("old\n");
    expect((await transactionArtifacts(parent)).length).toBe(3);

    release.resolve();
    await first;
    expect(await readFile(join(destination, "winner.txt"), "utf8")).toBe(
      "winner\n",
    );
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("does not overwrite a destination whose identity changes before promotion", async () => {
    const parent = await temporaryRoot("skizzles-stage-identity-");
    const destination = join(parent, "plugin");
    const displaced = join(parent, "displaced-plugin");
    await write(parent, "plugin/original.txt", "original\n");

    await expect(
      replaceDirectoryTransaction(destination, async (privateRoot) => {
        await writeFile(join(privateRoot, "staged.txt"), "staged\n");
        await rename(destination, displaced);
        await write(parent, "plugin/replacement.txt", "replacement\n");
      }),
    ).rejects.toThrow(
      "Plugin staging destination changed during the transaction.",
    );
    expect(await readFile(join(destination, "replacement.txt"), "utf8")).toBe(
      "replacement\n",
    );
    expect(await readFile(join(displaced, "original.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("commits mode 0755 and never rejects after lock replacement housekeeping", async () => {
    const parent = await temporaryRoot("skizzles-stage-committed-lock-");
    const destination = join(parent, "plugin");
    const displaced = join(parent, "displaced-lock");
    await write(parent, "plugin/old", "old\n");

    await expect(
      replaceDirectoryTransaction(
        destination,
        async (root) => {
          expect((await stat(root)).mode & PERMISSION_BITS).toBe(PRIVATE_MODE);
          await writeFile(join(root, "new"), "new\n");
        },
        {
          beforeLockCleanup: async (lock) => {
            await rename(lock, displaced);
            await mkdir(lock, { mode: PRIVATE_MODE });
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect((await stat(destination)).mode & PERMISSION_BITS).toBe(0o755);
    expect(await Bun.file(join(destination, "new")).exists()).toBe(true);
    expect(await Bun.file(join(destination, "old")).exists()).toBe(false);
    expect((await stat(displaced)).isDirectory()).toBe(true);
  });

  it("removes only identity-owned empty parents on precommit failure", async () => {
    const parent = await temporaryRoot("skizzles-stage-parent-cleanup-");
    const created = join(parent, "new/nested");
    await expect(
      replaceDirectoryTransaction(join(created, "plugin"), async () => {
        throw new Error("injected construction failure");
      }),
    ).rejects.toThrow("injected construction failure");
    expect(await Bun.file(created).exists()).toBe(false);
    expect(await Bun.file(join(parent, "new")).exists()).toBe(false);
  });

  it("treats partial backup disposal as committed recoverable housekeeping", async () => {
    const parent = await temporaryRoot("skizzles-stage-partial-cleanup-");
    const destination = join(parent, "plugin");
    await write(parent, "plugin/old-a", "a\n");
    await write(parent, "plugin/old-b", "b\n");

    await expect(
      replaceDirectoryTransaction(
        destination,
        (root) => writeFile(join(root, "new"), "new\n"),
        {
          beforeBackupCleanup: async (backup) => {
            await rm(join(backup, "previous/old-a"));
            throw new Error("injected partial disposal");
          },
        },
      ),
    ).resolves.toBeUndefined();
    const artifacts = await transactionArtifacts(parent);
    expect(artifacts.some((name) => name.includes("-backup-"))).toBe(true);
    expect(artifacts.some((name) => name.includes("-cleanup-"))).toBe(true);
    expect(await observeRecoveredDestination(destination)).toBe("new");
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("preserves a replacement swapped into backup disposal", async () => {
    const parent = await temporaryRoot("skizzles-backup-disposal-swap-");
    const destination = join(parent, "plugin");
    const displaced = join(parent, "displaced-backup");
    await write(parent, "plugin/old", "old\n");
    let replacement = "";

    await expect(
      replaceDirectoryTransaction(
        destination,
        (stage) => writeFile(join(stage, "new"), "new\n"),
        {
          checkpoint: async (point, path) => {
            if (point !== "backup-disposal-renamed" || path === undefined) {
              return;
            }
            replacement = path;
            await rename(path, displaced);
            await mkdir(path, { mode: PRIVATE_MODE });
            await writeFile(join(path, "attacker"), "preserve\n");
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(await readFile(join(replacement, "attacker"), "utf8")).toBe(
      "preserve\n",
    );
    let competingConstructionRan = false;
    await expect(
      replaceDirectoryTransaction(destination, () => {
        competingConstructionRan = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow();
    expect(competingConstructionRan).toBe(false);
  });

  it("preserves a replacement swapped into stage disposal", async () => {
    const parent = await temporaryRoot("skizzles-stage-disposal-swap-");
    const destination = join(parent, "plugin");
    const displaced = join(parent, "displaced-stage");
    let replacement = "";

    await expect(
      replaceDirectoryTransaction(
        destination,
        async (stage) => {
          await writeFile(join(stage, "partial"), "partial\n");
          throw new Error("construction failed");
        },
        {
          checkpoint: async (point, path) => {
            if (point !== "stage-disposal-remove" || path === undefined) {
              return;
            }
            replacement = path;
            await rename(path, displaced);
            await mkdir(path, { mode: PRIVATE_MODE });
            await writeFile(join(path, "attacker"), "preserve\n");
          },
        },
      ),
    ).rejects.toThrow("construction failed");
    expect(await readFile(join(replacement, "attacker"), "utf8")).toBe(
      "preserve\n",
    );
    let competingConstructionRan = false;
    await expect(
      replaceDirectoryTransaction(destination, () => {
        competingConstructionRan = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow();
    expect(competingConstructionRan).toBe(false);
  });

  it("recovers every promotion crash point and rejects an unclaimed lock", async () => {
    for (const [point, expected, exitCode] of [
      ["construction", "old", 72],
      ["stage-created", "old", 71],
      ["backup-ready", "old", 71],
      ["backup-renamed", "old", 71],
      ["destination-ready", "old", 71],
      ["destination-renamed", "new", 71],
      ["committed", "new", 71],
    ] as const) {
      const parent = await temporaryRoot(`skizzles-crash-${point}-`);
      const destination = join(parent, "plugin");
      await write(parent, "plugin/old", "old\n");
      expect(crashTransaction(destination, point)).toBe(exitCode);
      const observed = await observeRecoveredDestination(destination);
      expect(observed).toBe(expected);
    }
    const parent = await temporaryRoot("skizzles-crash-lock-publication-");
    const destination = join(parent, "plugin");
    const lock = transactionLockPath(await inspectTarget(destination));
    await mkdir(lock, { mode: PRIVATE_MODE });
    const stale = new Date(Date.now() - 60_000);
    await utimes(lock, stale, stale);
    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve()),
    ).rejects.toThrow("locked by another operation");
  }, 20_000);
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function transactionArtifacts(parent: string): Promise<string[]> {
  return (await readdir(parent))
    .filter(
      (name) =>
        name.startsWith(ARTIFACT_PREFIX) &&
        !name.includes(".recovery-highwater-"),
    )
    .sort();
}

function crashTransaction(destination: string, point: string): number {
  const module = resolve(
    import.meta.dir,
    "../../../src/plugin/destination/transaction.ts",
  );
  const source = `import { replaceDirectoryTransaction } from ${JSON.stringify(module)};\nawait replaceDirectoryTransaction(process.env.DEST, async (root) => { await Bun.write(root + "/new", "new\\n"); if (process.env.POINT === "construction") process.exit(72); }, { checkpoint: (point) => { if (point === process.env.POINT) process.exit(71); } });`;
  return Bun.spawnSync([process.execPath, "-e", source], {
    env: { ...process.env, DEST: destination, POINT: point },
    stderr: "pipe",
    stdout: "pipe",
  }).exitCode;
}

async function observeRecoveredDestination(
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
