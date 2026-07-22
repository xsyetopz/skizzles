import { afterEach, describe, expect, test } from "bun:test";
import type { SyncJournal } from "./support.ts";
import {
  crashApply,
  createSyncFixtureScope,
  execFileSync,
  firstBackup,
  initializeSyncBaseline,
  lstat,
  mkdir,
  mkdtemp,
  os,
  path,
  readdir,
  readFile,
  recoverSyncTransactions,
  required,
  rm,
  symlink,
  writeFile,
} from "./support.ts";

const fixtures = createSyncFixtureScope();
const { fixture, replaceNestedParent, repo, trackTemporaryPath } = fixtures;
afterEach(fixtures.cleanup);

const malformedJournalCases: ReadonlyArray<{
  readonly name: string;
  readonly tamper: (journal: SyncJournal, external: string) => void;
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
      required(journal.newBaseline.files["file.txt"], "baseline file").sha256 =
        "0".repeat(64);
    },
  },
];

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

  for (const entry of malformedJournalCases) {
    test(`rejects malformed journal ${entry.name} before recovery writes`, async () => {
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
    });
  }

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
    trackTemporaryPath(external);
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
