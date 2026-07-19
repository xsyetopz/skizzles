// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyPatchStrict, createPatch } from "../../src/assets/patch.ts";
import { PromptLayerError } from "../../src/lifecycle/contract.ts";
import {
  type PromptWorkspaceLifecycle,
  withPromptWorkspace,
  withPromptWorkspaceUsing,
} from "../../src/lifecycle/workspace.ts";
import {
  cleanupFixtures,
  fixtureDirectory,
  pathExistsForTest,
} from "./fixture.ts";

afterEach(cleanupFixtures);

describe("prompt operation workspace", () => {
  it("composed patch work shares one owned root and preserves outside files", async () => {
    const outside = await fixtureDirectory("outside");
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "outside\n");
    let runRoot = "";

    const baseline = Buffer.from("alpha\nbeta\n");
    const candidate = Buffer.from("alpha\nchanged\n");
    const output = await withPromptWorkspace(undefined, async (workspace) => {
      const patch = await createPatch(
        baseline,
        candidate,
        "nested/default.md",
        workspace,
      );
      const applied = await applyPatchStrict(
        baseline,
        patch,
        "nested/default.md",
        workspace,
      );
      const probe = await workspace.directory("test");
      runRoot = dirname(probe);
      const entries = await readdir(runRoot, { withFileTypes: true });
      expect(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort(),
      ).toEqual(["apply-1", "author-0", "test-2"]);
      return applied;
    });

    expect(output).toEqual(candidate);
    expect(await pathExistsForTest(runRoot)).toBeFalse();
    expect(await readFile(sentinel, "utf8")).toBe("outside\n");
  });
});

describe("prompt operation workspace failures", () => {
  it("closes the owned root when composed work throws", async () => {
    let runRoot = "";
    const failure = new Error("injected prompt operation failure");

    await expect(
      withPromptWorkspace(undefined, async (workspace) => {
        runRoot = dirname(await workspace.directory("test"));
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await pathExistsForTest(runRoot)).toBeFalse();
  });

  it("closes the owned root after cancellation", async () => {
    const cancellation = new AbortController();
    let runRoot = "";

    await expect(
      withPromptWorkspace(cancellation.signal, async (workspace) => {
        runRoot = dirname(await workspace.directory("test"));
        cancellation.abort(new Error("cancel prompt operation"));
        workspace.throwIfAborted();
      }),
    ).rejects.toMatchObject({ code: "RUN_WORKSPACE_ABORTED" });

    expect(await pathExistsForTest(runRoot)).toBeFalse();
    await expect(lstat(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("prompt operation cleanup failures", () => {
  it("reports cleanup failure after successful operation", async () => {
    await expect(
      withPromptWorkspaceUsing(
        undefined,
        () => Promise.resolve("completed"),
        cleanupFailureLifecycle(),
      ),
    ).rejects.toMatchObject({
      message: "Prompt run workspace cleanup failed: CLEANUP_FAILED.",
    });
  });

  it("reports cleanup failure and retains the operation error as cause", async () => {
    const operationError = new PromptLayerError("operation failed");
    const rejection = withPromptWorkspaceUsing(
      undefined,
      () => Promise.reject(operationError),
      cleanupFailureLifecycle(),
    );
    await expect(rejection).rejects.toBeInstanceOf(PromptLayerError);
    await expect(rejection).rejects.toMatchObject({
      message: "Prompt run workspace cleanup failed: CLEANUP_FAILED.",
      cause: operationError,
    });
  });
});

function cleanupFailureLifecycle(): PromptWorkspaceLifecycle {
  const controller = new AbortController();
  return {
    cleanupStale: () => Promise.resolve(),
    create: () =>
      Promise.resolve({
        signal: controller.signal,
        path: (...parts: readonly string[]): string => parts.join("/"),
        close: () =>
          Promise.resolve({
            state: "cleanup-failed",
            runId: "00000000-0000-4000-8000-000000000000",
            rootName: "redacted-run",
            children: [],
            error: "CLEANUP_FAILED",
          }),
      }),
  };
}
