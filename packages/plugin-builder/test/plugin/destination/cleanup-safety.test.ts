import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { replaceDirectoryTransaction } from "../../../src/plugin/destination/transaction.ts";
import { createTestWorkspace } from "../fixture.ts";

const { cleanup, temporaryRoot: allocateTemporaryRoot } = createTestWorkspace();
afterEach(cleanup);

describe("plugin destination cleanup safety", () => {
  it("holds same-target exclusion through committed housekeeping", async () => {
    const parent = await temporaryRoot("skizzles-housekeeping-barrier-");
    const destination = await seededDestination(parent);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let secondConstructed = false;
    const first = replaceDirectoryTransaction(
      destination,
      (stage) => writeFile(join(stage, "new"), "new\n"),
      {
        beforeBackupCleanup: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    );
    await entered.promise;
    await expect(
      replaceDirectoryTransaction(destination, () => {
        secondConstructed = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("locked by another operation");
    expect(secondConstructed).toBe(false);
    release.resolve();
    await first;
    await replaceDirectoryTransaction(destination, () => {
      secondConstructed = true;
      return Promise.resolve();
    });
    expect(secondConstructed).toBe(true);
  });

  it("retains the lock when staged cleanup is obstructed", async () => {
    const parent = await temporaryRoot("skizzles-stage-obstruction-");
    const destination = join(parent, "plugin");
    let obstruction = "";
    await expect(
      replaceDirectoryTransaction(destination, async (stage) => {
        obstruction = `${stage}.dispose`;
        await mkdir(obstruction, { mode: 0o700 });
        throw new Error("construction failed");
      }),
    ).rejects.toThrow("construction failed");
    let bypassed = false;
    await expect(
      replaceDirectoryTransaction(destination, () => {
        bypassed = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("conflicting private artifacts");
    expect(bypassed).toBe(false);
    expect((await transactionArtifacts(parent)).some(isLockArtifact)).toBe(
      true,
    );
    await rm(obstruction, { recursive: true });
    await expect(
      replaceDirectoryTransaction(destination, () =>
        Promise.reject(new Error("entered after cleanup")),
      ),
    ).rejects.toThrow("entered after cleanup");
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("retains the lock when rollback backup cleanup is obstructed", async () => {
    const parent = await temporaryRoot("skizzles-backup-obstruction-");
    const destination = await seededDestination(parent);
    let obstruction = "";
    await expect(
      replaceDirectoryTransaction(
        destination,
        (stage) => writeFile(join(stage, "new"), "new\n"),
        {
          checkpoint: async (point) => {
            if (point !== "backup-renamed") return;
            const backup = (await transactionArtifacts(parent)).find((name) =>
              name.includes("-backup-"),
            );
            obstruction = join(parent, `${String(backup)}.dispose`);
            await mkdir(obstruction, { mode: 0o700 });
            throw new Error("interrupt promotion");
          },
        },
      ),
    ).rejects.toThrow("rollback could not complete safely");
    let bypassed = false;
    await expect(
      replaceDirectoryTransaction(destination, () => {
        bypassed = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("conflicting private artifacts");
    expect(bypassed).toBe(false);
    expect(await readFile(join(destination, "old"), "utf8")).toBe("old\n");
    expect((await transactionArtifacts(parent)).some(isLockArtifact)).toBe(
      true,
    );
    await rm(obstruction, { recursive: true });
    await expect(
      replaceDirectoryTransaction(destination, () =>
        Promise.reject(new Error("entered after rollback cleanup")),
      ),
    ).rejects.toThrow("entered after rollback cleanup");
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("rejects symlink and non-directory destinations", async () => {
    const parent = await temporaryRoot("skizzles-destination-kind-");
    const outside = await temporaryRoot("skizzles-destination-outside-");
    const linked = join(parent, "linked");
    const file = join(parent, "file");
    await symlink(outside, linked);
    await writeFile(file, "not a directory\n");
    for (const destination of [linked, file]) {
      await expect(
        replaceDirectoryTransaction(destination, () => Promise.resolve()),
      ).rejects.toThrow("must be a real directory or absent");
    }
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  return allocateTemporaryRoot(prefix.replace(/-$/u, ""));
}

async function seededDestination(parent: string): Promise<string> {
  const destination = join(parent, "plugin");
  await mkdir(destination);
  await writeFile(join(destination, "old"), "old\n");
  return destination;
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

function isLockArtifact(name: string): boolean {
  return name.endsWith(".lock") || name.includes("-cleanup-");
}
