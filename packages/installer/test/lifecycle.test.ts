// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in module.
import { describe, expect, it } from "bun:test";
import { lstat } from "node:fs/promises";
import process from "node:process";
import {
  type CreateOptions,
  create,
  type RunWorkspace,
} from "@skizzles/run-workspace";
import {
  type InstallerLifecycle,
  runInstallerOperationWithLifecycle,
} from "../src/lifecycle.ts";

const CLEAN = {
  deleted: [],
  skipped: [],
  failed: [],
  truncated: false,
} as const;

describe("installer operation lifecycle", () => {
  it("maps real handled signals after deleting the owned root", async () => {
    if (process.platform === "win32") return;
    for (const [signal, status] of [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const source = [
        'import { runInstallerOperation } from "./src/lifecycle.ts";',
        'import { exitCodeForError } from "./src/cli.ts";',
        "try {",
        "  await runInstallerOperation(async (workspace) => {",
        "    console.log(workspace.path());",
        "    await new Promise(() => undefined);",
        "  });",
        "} catch (error) { process.exit(exitCodeForError(error)); }",
      ].join("\n");
      const child = Bun.spawn([process.execPath, "--eval", source], {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      });
      const first = await child.stdout.getReader().read();
      const root = new TextDecoder().decode(first.value).trim();
      process.kill(child.pid, signal);
      expect(await child.exited).toBe(status);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 15_000);

  it("fails a truncated stale scan before workspace creation", async () => {
    let created = false;
    const lifecycle: InstallerLifecycle = {
      cleanupStale: () => Promise.resolve({ ...CLEAN, truncated: true }),
      create: async () => {
        created = true;
        return await create();
      },
    };
    await expect(
      runInstallerOperationWithLifecycle(async () => undefined, lifecycle),
    ).rejects.toThrow("stale workspace cleanup failed");
    expect(created).toBeFalse();
  });

  it("preserves an operation rejection whose value is undefined", async () => {
    const lifecycle = realLifecycle();
    let rejection: unknown = "not rejected";
    try {
      await runInstallerOperationWithLifecycle(
        () => Promise.reject(undefined),
        lifecycle,
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeUndefined();
  });

  it("orders cleanup failure before the operation failure", async () => {
    const release = Promise.withResolvers<void>();
    let workspace: RunWorkspace | undefined;
    const lifecycle = realLifecycle((created) => {
      workspace = created;
    });
    let rejection: unknown;
    try {
      await runInstallerOperationWithLifecycle(async (runWorkspace) => {
        runWorkspace.registerChild({
          label: "stuck installer child",
          requestStop: () => undefined,
          forceStop: () => undefined,
          waitForExit: () => release.promise,
        });
        throw new Error("operation failed");
      }, lifecycle);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("temporary cleanup failed");
    const cause = (rejection as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors[0]).toBeInstanceOf(Error);
    expect((cause as AggregateError).errors[1]).toMatchObject({
      message: "operation failed",
    });
    release.resolve();
    await workspace?.close();
  });
});

function realLifecycle(
  observe: (workspace: RunWorkspace) => void = () => undefined,
): InstallerLifecycle {
  return {
    cleanupStale: () => Promise.resolve(CLEAN),
    create: async (options: CreateOptions = {}) => {
      const workspace = await create({
        ...options,
        gracefulStopMs: 1,
        forceStopMs: 1,
      });
      observe(workspace);
      return workspace;
    },
  };
}
