import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  inspectTarget,
  transactionLockPath,
} from "../../../../src/plugin/destination/path.ts";
import { replaceDirectoryTransaction } from "../../../../src/plugin/destination/transaction/apply.ts";
import {
  JOURNAL_FILE,
  parseOwner,
  parsePrivateJson,
  temporaryName,
} from "../../../../src/plugin/destination/transaction/journal.ts";
import { createTestWorkspace } from "../../fixture.ts";

const TOKEN_X = "00000000-0000-4000-8000-000000000001";
const TOKEN_Y = "00000000-0000-4000-8000-000000000002";

const { cleanup, temporaryRoot: allocateTemporaryRoot } = createTestWorkspace();
afterEach(cleanup);

describe("plugin destination lock disposal", () => {
  it("blocks on a cleanup path whose owner token differs", async () => {
    const parent = await temporaryRoot("skizzles-cleanup-token-");
    const destination = join(parent, "plugin");
    const target = await inspectTarget(destination);
    const cleanup = join(
      parent,
      `.skizzles-package-${target.key}-cleanup-${TOKEN_X}`,
    );
    await mkdir(cleanup, { mode: 0o700 });
    await writeFile(
      join(cleanup, "owner.json"),
      `${JSON.stringify({
        version: 2,
        controllerPid: 999_999_999,
        controllerStartIdentity: "dead",
        pid: 999_999_999,
        processStartIdentity: "dead",
        token: TOKEN_Y,
      })}\n`,
    );
    await writeFile(join(cleanup, "unrelated"), "preserved\n");

    let constructed = false;
    await expect(
      replaceDirectoryTransaction(destination, () => {
        constructed = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("locked by another operation");

    expect(constructed).toBe(false);
    expect(await readFile(join(cleanup, "unrelated"), "utf8")).toBe(
      "preserved\n",
    );
  });

  it("keeps a canonical lock when cleanup-state publication fails", async () => {
    const parent = await temporaryRoot("skizzles-cleanup-publication-");
    const destination = join(parent, "plugin");
    await writeFile(destinationSeed(parent), "old\n");
    const lock = transactionLockPath(await inspectTarget(destination));

    await replaceDirectoryTransaction(
      destination,
      (stage) => writeFile(join(stage, "new"), "new\n"),
      {
        beforeBackupCleanup: async (backup) => {
          const token = basename(backup).slice(-36);
          await mkdir(join(lock, temporaryName(JOURNAL_FILE, token)));
          throw new Error("injected cleanup publication failure");
        },
      },
    );

    const retained = await transactionArtifacts(parent);
    expect(retained.some((name) => name.endsWith(".lock"))).toBe(true);
    expect(retained.some((name) => name.includes("-cleanup-"))).toBe(false);
    const entries = await readdir(lock);
    const obstruction = entries.find((name) => name.endsWith(".tmp"));
    if (obstruction !== undefined) {
      await rm(join(lock, obstruction), { recursive: true });
    }
    await replaceDirectoryTransaction(destination, (stage) =>
      writeFile(join(stage, "newer"), "newer\n"),
    );
    expect(await nonAllocatorArtifacts(parent)).toEqual([]);
  });

  it("recovers journal-first and owner-last cleanup disposal crashes", async () => {
    for (const removeOwner of [false, true]) {
      const parent = await temporaryRoot("skizzles-cleanup-partial-");
      const destination = join(parent, "plugin");
      await writeFile(destinationSeed(parent), "old\n");
      await replaceDirectoryTransaction(
        destination,
        (stage) => writeFile(join(stage, "new"), "new\n"),
        { beforeBackupCleanup: () => Promise.reject(new Error("retain")) },
      );
      const artifacts = await transactionArtifacts(parent);
      const backup = artifacts.find((name) => name.includes("-backup-"));
      const cleanup = artifacts.find((name) => name.includes("-cleanup-"));
      expect(backup).toBeDefined();
      expect(cleanup).toBeDefined();
      await rm(join(parent, String(backup)), { recursive: true });
      const disposal = `${join(parent, String(cleanup))}.dispose`;
      await rename(join(parent, String(cleanup)), disposal);
      const ownerPath = join(disposal, "owner.json");
      await rm(join(disposal, JOURNAL_FILE));
      if (removeOwner) await rm(ownerPath);
      await expect(
        replaceDirectoryTransaction(destination, () =>
          Promise.reject(new Error("observe")),
        ),
      ).rejects.toThrow("observe");
      expect(await nonAllocatorArtifacts(parent)).toEqual([]);
    }
  });

  it("does not acquire a new lock when allowlisted teardown fails", async () => {
    const parent = await temporaryRoot("skizzles-cleanup-obstructed-");
    const destination = join(parent, "plugin");
    await writeFile(destinationSeed(parent), "old\n");
    await replaceDirectoryTransaction(
      destination,
      (stage) => writeFile(join(stage, "new"), "new\n"),
      {
        beforeLockCleanup: (lock) =>
          writeFile(join(lock, "unexpected"), "preserved\n"),
      },
    );
    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve()),
    ).rejects.toThrow("could not clean up its private lock");
    const artifacts = await transactionArtifacts(parent);
    expect(artifacts).toHaveLength(5);
    expect(artifacts.some((name) => name.endsWith(".claim"))).toBe(true);
    expect(artifacts.some((name) => name.endsWith(".lock.dispose"))).toBe(true);
    expect(artifacts.some((name) => name.includes(".claim.recovery-"))).toBe(
      true,
    );
    expect(artifacts.filter((name) => name.endsWith(".retired"))).toHaveLength(
      2,
    );
  });

  it("retains foreign-token temporary lock metadata", async () => {
    const parent = await temporaryRoot("skizzles-cleanup-foreign-temp-");
    const destination = join(parent, "plugin");
    await writeFile(destinationSeed(parent), "old\n");
    let foreign = "";
    await replaceDirectoryTransaction(
      destination,
      (stage) => writeFile(join(stage, "new"), "new\n"),
      {
        beforeLockCleanup: async (lock) => {
          const owner = parseOwner(
            parsePrivateJson(await readFile(join(lock, "owner.json"), "utf8")),
          );
          const token = owner.token === TOKEN_X ? TOKEN_Y : TOKEN_X;
          const name = temporaryName(JOURNAL_FILE, token);
          foreign = join(`${lock}.dispose`, name);
          await writeFile(join(lock, name), "preserved\n");
        },
      },
    );
    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve()),
    ).rejects.toThrow("could not clean up its private lock");
    expect(await readFile(foreign, "utf8")).toBe("preserved\n");
  });

  it("treats every invalid cleanup namespace as lock-equivalent", async () => {
    for (const [label, candidates] of [
      ["malformed", [["not-a-token", 0o700]]],
      ["wrong-mode", [[TOKEN_X, 0o755]]],
      [
        "multiple",
        [
          [TOKEN_X, 0o700],
          [TOKEN_Y, 0o700],
        ],
      ],
      [
        "conflict",
        [
          [TOKEN_X, 0o700],
          [`${TOKEN_X}.dispose`, 0o700],
        ],
      ],
    ] as const) {
      const parent = await temporaryRoot(`skizzles-cleanup-${label}-`);
      const destination = join(parent, "plugin");
      const { key } = await inspectTarget(destination);
      for (const [suffix, mode] of candidates) {
        await mkdir(
          join(parent, `.skizzles-package-${key}-cleanup-${suffix}`),
          { mode },
        );
      }
      let constructed = false;

      await expect(
        replaceDirectoryTransaction(destination, () => {
          constructed = true;
          return Promise.resolve();
        }),
      ).rejects.toThrow("locked by another operation");
      expect(constructed).toBe(false);
    }
  });
});

function destinationSeed(parent: string): string {
  const destination = join(parent, "plugin");
  return join(destination, "old");
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await allocateTemporaryRoot(prefix.replace(/-$/u, ""));
  await mkdir(join(root, "plugin"));
  return root;
}

async function transactionArtifacts(parent: string): Promise<string[]> {
  return (await readdir(parent)).filter((name) =>
    name.startsWith(".skizzles-package-"),
  );
}

async function nonAllocatorArtifacts(parent: string): Promise<string[]> {
  return (await transactionArtifacts(parent)).filter(
    (name) => !name.includes(".recovery-highwater-"),
  );
}
