import { afterEach, describe, expect, it } from "bun:test";
import process from "node:process";
import type { DirectoryIdentity } from "../../src/sync/contract.ts";
import { retireCreatedDirectories } from "../../src/sync/directories.ts";
import {
  crashApply,
  createSyncFixtureScope,
  execFileSync,
  firstBackup,
  lstat,
  mkdir,
  mkdtemp,
  os,
  path,
  readFile,
  recoverSyncTransactions,
  rm,
  symlink,
  writeFile,
} from "./support.ts";

const fixtures = createSyncFixtureScope();
const { fixture, trackTemporaryPath } = fixtures;
afterEach(fixtures.cleanup);

type RecoveryCrashPoint =
  | "before-removal"
  | "after-removal"
  | "after-parent-sync"
  | "after-all-retirements";

async function preparedDirectoryCrash() {
  const state = await fixture();
  await mkdir(path.join(state.source, "nested", "deep"), { recursive: true });
  await writeFile(
    path.join(state.source, "nested", "deep", "new.txt"),
    "new\n",
  );
  execFileSync("git", ["-C", state.source, "add", "nested/deep/new.txt"]);
  const crash = await crashApply(state);
  const created = crash.journal.createdDirectories.map((entry) => entry.path);
  if (
    crash.journal.state !== "prepared" ||
    JSON.stringify(created) !== JSON.stringify(["nested", "nested/deep"])
  ) {
    throw new Error(
      "Crash fixture did not retain the expected prepared journal",
    );
  }
  return { state, crash };
}

async function crashRecovery(
  state: Awaited<ReturnType<typeof fixture>>,
  point: RecoveryCrashPoint,
): Promise<void> {
  const modulePath = path.join(import.meta.dir, "../../src/sync/recovery.ts");
  const script = `
    const { recoverSyncTransactions } = await import(${JSON.stringify(
      modulePath,
    )});
    const options = JSON.parse(process.env.SYNC_RECOVERY_OPTIONS);
    const point = process.env.SYNC_RECOVERY_POINT;
    let visited = 0;
    const crash = () => process.exit(87);
    await recoverSyncTransactions(options, {
      directoryRetirement: {
        beforeRemoval: () => {
          visited++;
          if (point === "before-removal" && visited === 1) crash();
        },
        afterRemoval: () => {
          if (point === "after-removal" && visited === 1) crash();
        },
        afterParentSync: () => {
          if (point === "after-parent-sync" && visited === 1) crash();
        },
      },
      afterCreatedDirectoriesRetired: () => {
        if (point === "after-all-retirements") crash();
      },
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      SYNC_RECOVERY_OPTIONS: JSON.stringify({
        ...state,
        allowedTargetRoots: [state.target],
      }),
      SYNC_RECOVERY_POINT: point,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 87) {
    throw new Error(`Recovery crash fixture exited ${exitCode}: ${stderr}`);
  }
}

async function expectAbsent(absolute: string): Promise<void> {
  try {
    await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Expected path to be absent: ${absolute}`);
}

async function recover(state: Awaited<ReturnType<typeof fixture>>) {
  return recoverSyncTransactions({
    ...state,
    allowedTargetRoots: [state.target],
  });
}

describe("prepared directory retirement replay", () => {
  for (const point of [
    "before-removal",
    "after-removal",
    "after-parent-sync",
  ] as const) {
    it(`replays a crash ${point} at the deepest directory`, async () => {
      const { state, crash } = await preparedDirectoryCrash();
      await crashRecovery(state, point);

      expect(JSON.parse(await readFile(crash.journalPath, "utf8")).state).toBe(
        "prepared",
      );
      if (point === "before-removal") {
        expect(
          (
            await lstat(path.join(state.target, "nested", "deep"))
          ).isDirectory(),
        ).toBe(true);
      } else {
        await expectAbsent(path.join(state.target, "nested", "deep"));
      }
      expect(
        (await lstat(path.join(state.target, "nested"))).isDirectory(),
      ).toBe(true);

      expect(await recover(state)).toBe(1);
      expect(await recover(state)).toBe(0);
      await expectAbsent(path.join(state.target, "nested"));
      await expectAbsent(crash.journalPath);
    });
  }

  it("replays a crash after every removal and before the durable rolledBack journal", async () => {
    const { state, crash } = await preparedDirectoryCrash();
    await crashRecovery(state, "after-all-retirements");

    await expectAbsent(path.join(state.target, "nested"));
    const retained = JSON.parse(await readFile(crash.journalPath, "utf8"));
    expect(retained.state).toBe("prepared");
    expect(retained.createdDirectories).toEqual(
      crash.journal.createdDirectories,
    );

    expect(await recover(state)).toBe(1);
    expect(await recover(state)).toBe(0);
    await expectAbsent(crash.journalPath);
  });

  it("re-fsyncs a present parent when replay finds its retired child absent", async () => {
    const { state, crash } = await preparedDirectoryCrash();
    await crashRecovery(state, "after-removal");
    await expectAbsent(path.join(state.target, "nested", "deep"));

    await crashRecovery(state, "after-parent-sync");
    expect((await lstat(path.join(state.target, "nested"))).isDirectory()).toBe(
      true,
    );
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);

    expect(await recover(state)).toBe(1);
    await expectAbsent(path.join(state.target, "nested"));
  });

  for (const replacement of ["directory", "symlink", "file"] as const) {
    it(`preserves a retired directory replaced by a ${replacement}`, async () => {
      const { state, crash } = await preparedDirectoryCrash();
      await crashRecovery(state, "after-parent-sync");
      const retired = path.join(state.target, "nested", "deep");
      const outside = trackTemporaryPath(
        await mkdtemp(path.join(os.tmpdir(), "sync-retirement-outside-")),
      );
      await writeFile(path.join(outside, "sentinel.txt"), "keep\n");
      if (replacement === "directory") {
        await mkdir(retired);
      } else if (replacement === "symlink") {
        await symlink(outside, retired);
      } else {
        await writeFile(retired, "keep\n");
      }

      await expect(recover(state)).rejects.toThrow(
        "recovery conflict at nested/deep",
      );
      expect((await lstat(crash.journalPath)).isFile()).toBe(true);
      if (replacement === "directory") {
        expect((await lstat(retired)).isDirectory()).toBe(true);
      } else if (replacement === "symlink") {
        expect((await lstat(retired)).isSymbolicLink()).toBe(true);
        expect(await readFile(path.join(retired, "sentinel.txt"), "utf8")).toBe(
          "keep\n",
        );
      } else {
        expect(await readFile(retired, "utf8")).toBe("keep\n");
      }
    });
  }

  it("preserves an unsafe recreated ancestor", async () => {
    const { state, crash } = await preparedDirectoryCrash();
    await crashRecovery(state, "after-all-retirements");
    const outside = trackTemporaryPath(
      await mkdtemp(path.join(os.tmpdir(), "sync-retirement-ancestor-")),
    );
    await writeFile(path.join(outside, "sentinel.txt"), "keep\n");
    await symlink(outside, path.join(state.target, "nested"));

    await expect(recover(state)).rejects.toThrow(
      "recovery conflict at nested/deep",
    );
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);
    expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe(
      "keep\n",
    );
  });

  it("rejects absence caused by an unrecorded preexisting ancestor", async () => {
    const state = await fixture();
    await mkdir(path.join(state.source, "nested", "deep"), { recursive: true });
    await mkdir(path.join(state.target, "nested"));
    await writeFile(
      path.join(state.source, "nested", "deep", "new.txt"),
      "new\n",
    );
    execFileSync("git", ["-C", state.source, "add", "nested/deep/new.txt"]);
    const crash = await crashApply(state);
    expect(crash.journal.createdDirectories.map((entry) => entry.path)).toEqual(
      ["nested/deep"],
    );
    await crashRecovery(state, "after-parent-sync");
    await rm(path.join(state.target, "nested"), { recursive: true });

    await expect(recover(state)).rejects.toThrow(
      "recovery conflict at nested/deep",
    );
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);
  });

  it("preserves an exact journal-owned directory that became nonempty", async () => {
    const { state, crash } = await preparedDirectoryCrash();
    await crashRecovery(state, "before-removal");
    const retained = path.join(state.target, "nested", "deep", "sentinel.txt");
    await writeFile(retained, "keep\n");

    await expect(recover(state)).rejects.toThrow(
      "recovery conflict at nested/deep",
    );
    expect(await readFile(retained, "utf8")).toBe("keep\n");
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);
  });

  it("validates publication provenance before replay writes", async () => {
    const { state, crash } = await preparedDirectoryCrash();
    await crashRecovery(state, "after-all-retirements");
    firstBackup(crash.journal).publication = path.join(
      state.stateRoot,
      "outside.tmp",
    );
    await writeFile(crash.journalPath, JSON.stringify(crash.journal));

    await expect(recover(state)).rejects.toThrow(
      "Invalid synchronization publication provenance",
    );
    await expectAbsent(path.join(state.target, "nested"));
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);
  });

  it("keeps missing created directories strict for applied journals", async () => {
    const state = await fixture();
    await mkdir(path.join(state.source, "nested"));
    await writeFile(path.join(state.source, "nested", "new.txt"), "new\n");
    execFileSync("git", ["-C", state.source, "add", "nested/new.txt"]);
    const crash = await crashApply(state, "after-journal");
    expect(crash.journal.state).toBe("applied");
    await rm(path.join(state.target, "nested"), { recursive: true });

    await expect(recover(state)).rejects.toThrow("recovery conflict at nested");
    expect((await lstat(crash.journalPath)).isFile()).toBe(true);
  });

  it("direct retirement is idempotent for journal-owned identities", async () => {
    const state = await fixture();
    const parent = path.join(state.target, "nested");
    const child = path.join(parent, "deep");
    await mkdir(child, { recursive: true });
    const identities: DirectoryIdentity[] = [];
    for (const [relative, absolute] of [
      ["nested", parent],
      ["nested/deep", child],
    ] as const) {
      const stat = await lstat(absolute, { bigint: true });
      identities.push({
        path: relative,
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
      });
    }

    await retireCreatedDirectories(state.target, identities);
    await retireCreatedDirectories(state.target, identities);
    await expectAbsent(parent);
  });
});
