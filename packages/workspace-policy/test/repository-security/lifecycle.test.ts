// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CleanupReport,
  type CreateOptions,
  create,
  type RunWorkspace,
  RunWorkspaceAbortedError,
} from "@skizzles/run-workspace";
import {
  type RepositorySecurityLifecycle,
  runRepositorySecurityGateWithLifecycle,
} from "../../src/repository-security/gate.ts";
import { createSecurityFixtureScope } from "./support.ts";

const fixtures = createSecurityFixtureScope();
const OPERATION_PREFIX_LENGTH = 3;
afterEach(fixtures.cleanup);

describe("repository security run workspace", () => {
  it("fails before create and operation when stale cleanup is incomplete", async () => {
    let created = false;
    let operated = false;
    const lifecycle: RepositorySecurityLifecycle = {
      cleanupStale: () =>
        Promise.resolve({
          deleted: [],
          skipped: [],
          failed: [{ rootName: "retained", error: "CLEANUP_FAILED" }],
          truncated: false,
        }),
      create: async () => {
        created = true;
        return await create();
      },
    };
    await expect(
      runRepositorySecurityGateWithLifecycle("/unused", lifecycle, async () => {
        operated = true;
      }),
    ).rejects.toThrow(
      "stale workspace cleanup failed: retained:CLEANUP_FAILED",
    );
    expect(created).toBeFalse();
    expect(operated).toBeFalse();
  });

  it("preserves the workspace abort reason over an operation failure", async () => {
    const controller = new AbortController();
    const base = recordingLifecycle([], () => undefined);
    const lifecycle: RepositorySecurityLifecycle = {
      ...base,
      create: (options = {}) =>
        base.create({ ...options, signal: controller.signal }),
    };
    let reason: unknown;
    let rejection: unknown;
    try {
      await runRepositorySecurityGateWithLifecycle(
        "/unused",
        lifecycle,
        async (_root, workspace) => {
          controller.abort();
          await Bun.sleep(0);
          reason = workspace.signal.reason;
          throw new Error("secondary operation failure");
        },
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBe(reason);
    expect(reason).toBeInstanceOf(RunWorkspaceAbortedError);
  });

  it("creates one marked root after stale cleanup and deletes it after children", async () => {
    const outside = await fixtures.directory("outside");
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "keep\n");
    const events: string[] = [];
    let created = 0;
    let root = "";
    const lifecycle = recordingLifecycle(events, (workspace) => {
      created += 1;
      root = workspace.path();
    });

    await runRepositorySecurityGateWithLifecycle(
      outside,
      lifecycle,
      async (_workspaceRoot, workspace) => {
        events.push("operation");
        expect(
          (await readdir(workspace.path())).filter((name) =>
            name.startsWith(".skizzles-run-workspace"),
          ),
        ).toHaveLength(1);
        await mkdir(workspace.path("Downloads"));
        workspace.registerChild({
          label: "security probe",
          requestStop: async () => {
            expect(await exists(root)).toBeTrue();
            events.push("child");
          },
          forceStop: () => undefined,
          waitForExit: async () => {
            if (!events.includes("child")) {
              await Bun.sleep(1);
            }
          },
        });
      },
    );

    expect(created).toBe(1);
    expect(events.slice(0, OPERATION_PREFIX_LENGTH)).toEqual([
      "stale",
      "create",
      "operation",
    ]);
    expect(events).toContain("child");
    expect(await exists(root)).toBeFalse();
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");
  });

  it("cleans the complete root when the security operation throws", async () => {
    let root = "";
    const lifecycle = recordingLifecycle([], (workspace) => {
      root = workspace.path();
    });
    await expect(
      runRepositorySecurityGateWithLifecycle(
        "/unused/repository",
        lifecycle,
        async (_workspaceRoot, workspace) => {
          await writeFile(workspace.path("failure-evidence"), "transient\n");
          throw new Error("security operation failed");
        },
      ),
    ).rejects.toThrow("security operation failed");
    expect(await exists(root)).toBeFalse();
  });

  it("retains an owned marked root when a child exit cannot be confirmed", async () => {
    const exit = Promise.withResolvers<void>();
    let workspace: RunWorkspace | undefined;
    let root = "";
    const lifecycle = recordingLifecycle([], (created) => {
      workspace = created;
      root = created.path();
    });

    await expect(
      runRepositorySecurityGateWithLifecycle(
        "/unused/repository",
        lifecycle,
        (_workspaceRoot, runWorkspace) => {
          runWorkspace.registerChild({
            label: "stuck security tool",
            requestStop: () => undefined,
            forceStop: () => undefined,
            waitForExit: () => exit.promise,
          });
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow("temporary cleanup failed: CHILD_UNCONFIRMED");
    expect(await exists(root)).toBeTrue();
    expect(
      (
        await readFile(join(root, ".skizzles-run-workspace.json"), "utf8")
      ).includes('"state": "cleanup-failed"'),
    ).toBeTrue();

    exit.resolve();
    const retained = workspace;
    if (retained === undefined) {
      throw new Error("Expected retained workspace");
    }
    expect((await retained.close()).state).toBe("deleted");
    expect(await exists(root)).toBeFalse();
  });
});

function recordingLifecycle(
  events: string[],
  created: (workspace: RunWorkspace) => void,
): RepositorySecurityLifecycle {
  return {
    cleanupStale: (): Promise<CleanupReport> => {
      events.push("stale");
      return Promise.resolve({
        deleted: [],
        skipped: [],
        failed: [],
        truncated: false,
      });
    },
    create: async (options: CreateOptions = {}): Promise<RunWorkspace> => {
      events.push("create");
      const workspace = await create({
        ...options,
        gracefulStopMs: 1,
        forceStopMs: 1,
      });
      created(workspace);
      return workspace;
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
