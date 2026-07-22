import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import type { SyncFile } from "../../src/files.ts";
import {
  applySync,
  compareManifests,
  initializeSyncBaseline,
  previewSync,
  recoverSyncTransactions,
} from "../../src/sync/api.ts";
import type { StoredPreview, SyncJournal } from "../../src/sync/contract.ts";
import { previewBinding } from "../../src/sync/preview.ts";

export function createSyncFixtureScope() {
  const temporary = new Set<string>();

  function trackTemporaryPath(root: string): string {
    temporary.add(root);
    return root;
  }

  async function cleanup(): Promise<void> {
    const roots = [...temporary];
    temporary.clear();
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  async function repo(prefix: string): Promise<string> {
    const root = trackTemporaryPath(
      await mkdtemp(path.join(os.tmpdir(), prefix)),
    );
    execFileSync("git", ["init", "-q", root]);
    return root;
  }

  async function fixture() {
    const source = await repo("container-lab-source-");
    const target = await repo("container-lab-target-");
    const stateRoot = trackTemporaryPath(
      await mkdtemp(path.join(os.tmpdir(), "container-lab-state-")),
    );
    for (const root of [source, target]) {
      await writeFile(path.join(root, "file.txt"), "base\n");
      execFileSync("git", ["-C", root, "add", "file.txt"]);
    }
    const identity = { stateRoot, labId: "lab-1" };
    await initializeSyncBaseline(identity, target);
    return { source, target, ...identity };
  }

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
      const outside = trackTemporaryPath(
        await mkdtemp(path.join(os.tmpdir(), "sync-outside-")),
      );
      await writeFile(path.join(outside, "sentinel.txt"), "keep\n");
      await symlink(outside, parent);
    }
    return parent;
  }

  return {
    cleanup,
    fixture,
    replaceNestedParent,
    repo,
    trackTemporaryPath,
  };
}

export function file(pathname: string, hash: string): SyncFile {
  return { path: pathname, kind: "file", sha256: hash, size: 1, mode: 0o644 };
}

export type SyncFixture = Awaited<
  ReturnType<ReturnType<typeof createSyncFixtureScope>["fixture"]>
>;
export type CrashPoint =
  | "after-directory-created"
  | "before-publish"
  | "after-publish"
  | "after-journal"
  | "after-baseline";

export function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

export function firstBackup(journal: SyncJournal) {
  return required(journal.backups[0], "journal backup");
}

export async function crashApply(
  state: SyncFixture,
  point: CrashPoint = "after-publish",
): Promise<{ journal: SyncJournal; journalPath: string }> {
  const preview = await previewSync({
    ...state,
    direction: "push",
    sourceRoot: state.source,
    targetRoot: state.target,
  });
  const modulePath = path.join(import.meta.dir, "../../src/sync/apply.ts");
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

export type ParentReplacement = "removed" | "recreated" | "symlink";

export type { StoredPreview, SyncFile, SyncJournal };
export {
  applySync,
  chmod,
  compareManifests,
  execFileSync,
  initializeSyncBaseline,
  lstat,
  mkdir,
  mkdtemp,
  os,
  path,
  previewBinding,
  previewSync,
  process,
  randomUUID,
  readdir,
  readFile,
  readlink,
  recoverSyncTransactions,
  rm,
  symlink,
  writeFile,
};
