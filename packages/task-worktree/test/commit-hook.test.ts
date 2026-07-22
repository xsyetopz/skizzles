// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  commitMessageHookEntrypoint,
  commitMessageHookExitCode,
  temporaryCommitMessageHookPath,
} from "../src/commit/hook.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (path) => await rm(path, { force: true, recursive: true })),
  );
});

async function temporaryMessage(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-commit-msg-"));
  temporaryRoots.push(root);
  const path = join(root, "COMMIT_EDITMSG");
  await writeFile(path, content, "utf8");
  return path;
}

describe("commit-msg hook", () => {
  it("uses the exact conventional parser for valid and invalid hook files", async () => {
    const validPath = await temporaryMessage("feat(task-worktree): add hook\n");
    const invalidPath = await temporaryMessage(
      "feat(task-worktree): add hook\nInjected: true\n",
    );
    expect(
      commitMessageHookExitCode(
        Object.freeze(["bun", "hook", validPath]),
        () => "feat(task-worktree): add hook\n",
      ),
    ).toBe(0);
    expect(
      commitMessageHookExitCode(
        Object.freeze(["bun", "hook", invalidPath]),
        () => "feat(task-worktree): add hook\nInjected: true",
      ),
    ).toBe(1);
    expect(
      commitMessageHookExitCode(
        Object.freeze(["bun", "hook", validPath]),
        () => "feat(task-worktree): add hook\r\n",
      ),
    ).toBe(1);
    expect(
      commitMessageHookExitCode(
        Object.freeze(["bun", "hook", validPath]),
        () => "feat(task-worktree): add hook\n\n",
      ),
    ).toBe(1);
    expect(
      commitMessageHookExitCode(
        Object.freeze(["bun", "hook"]),
        () => "feat(task-worktree): add hook",
      ),
    ).toBe(1);
  });

  it("runs as a commit-msg runtime entrypoint and exposes a temporary hook path", async () => {
    const validPath = await temporaryMessage("feat(task-worktree): add hook\n");
    const invalidPath = await temporaryMessage(
      "feat(task-worktree): add hook\nInjected: true",
    );
    const valid = Bun.spawn([
      process.execPath,
      commitMessageHookEntrypoint,
      validPath,
    ]);
    const invalid = Bun.spawn([
      process.execPath,
      commitMessageHookEntrypoint,
      invalidPath,
    ]);
    expect(await valid.exited).toBe(0);
    expect(await invalid.exited).toBe(1);
    const hooksDirectory = join(tmpdir(), "skizzles-hooks");
    expect(temporaryCommitMessageHookPath(hooksDirectory)).toBe(
      join(hooksDirectory, "commit-msg"),
    );
    expect(temporaryCommitMessageHookPath("relative-hooks")).toBeUndefined();
  });
});
