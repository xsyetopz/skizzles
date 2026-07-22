import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  cleanupStale,
  create,
  type RunWorkspace,
  RunWorkspaceAbortedError,
} from "@skizzles/scratchspace";
import { PackagingError } from "../../src/plugin/contract.ts";
import {
  assertSupervisorPlatform,
  runInstallerHelp,
  runInstallerHelpUsing,
  signalOwnedGuardian,
} from "../../src/plugin/runtime-process.ts";
import {
  checkPluginWithWorkspace,
  stagePluginWithWorkspace,
} from "../../src/plugin/staging.ts";
import {
  adaptPluginWorkspace,
  withPluginWorkspaceUsing,
} from "../../src/plugin/workspace.ts";
import { createTestWorkspace, write } from "./fixture.ts";

const outside = createTestWorkspace();
afterEach(outside.cleanup);

describe("plugin run workspace composition", () => {
  it("shares one marked root across prompt, comparison, and runtime checks", async () => {
    const repoRoot = await outside.fixture();
    const sentinelRoot = await outside.temporaryRoot("outside-sentinel");
    await write(sentinelRoot, "preserved", "outside\n");
    const generatedRoot = join(repoRoot, "plugins/skizzles");
    let runRoot = "";
    let cleanupObserved = false;

    await withPluginWorkspaceUsing(
      async (workspace) => {
        runRoot = workspace.path();
        await stagePluginWithWorkspace(repoRoot, generatedRoot, workspace);
        await checkPluginWithWorkspace(repoRoot, workspace);
        expect(generatedRoot.startsWith(runRoot)).toBe(false);
        const entries = await readdir(runRoot);
        expect(entries).toEqual(
          expect.arrayContaining(["comparison", "prompt"]),
        );
        expect(entries).toContain("process-temp");
      },
      {
        cleanupStale: async () => {
          cleanupObserved = true;
          await cleanupStale();
        },
        create: async () => {
          expect(cleanupObserved).toBe(true);
          return create();
        },
      },
    );

    expect(await directoryExists(runRoot)).toBe(false);
    expect(await Bun.file(join(sentinelRoot, "preserved")).text()).toBe(
      "outside\n",
    );
  }, 10_000);

  it("cleans exception and cancellation paths", async () => {
    for (const mode of ["exception", "cancellation"] as const) {
      const controller = new AbortController();
      let owned: RunWorkspace | undefined;
      let ownedRoot = "";
      await expect(
        withPluginWorkspaceUsing(
          async (workspace) => {
            await mkdir(workspace.path("artifact"));
            if (mode === "cancellation") {
              controller.abort();
              await Bun.sleep(0);
              workspace.signal.throwIfAborted();
            }
            throw new Error("operation failed");
          },
          {
            cleanupStale: async () => undefined,
            create: async () => {
              owned = await create({ signal: controller.signal });
              ownedRoot = owned.path();
              return owned;
            },
          },
        ),
      ).rejects.toBeInstanceOf(
        mode === "cancellation" ? RunWorkspaceAbortedError : Error,
      );
      expect(owned).toBeDefined();
      expect(await directoryExists(ownedRoot)).toBe(false);
    }
  });

  it("cleans only the workspace owned by each test harness", async () => {
    const first = createTestWorkspace();
    const second = createTestWorkspace();
    const firstRoot = await first.temporaryRoot("first-owner");
    const secondRoot = await second.temporaryRoot("second-owner");
    try {
      await first.cleanup();
      expect(await directoryExists(firstRoot)).toBe(false);
      expect(await directoryExists(secondRoot)).toBe(true);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
    expect(await directoryExists(secondRoot)).toBe(false);
  });

  it("waits for registered children before removing the root", async () => {
    let runRoot = "";
    let rootObserved = false;
    const exited = Promise.withResolvers<void>();
    await withPluginWorkspaceUsing(
      async (workspace) => {
        runRoot = workspace.path();
        workspace.registerChild({
          label: "child-before-root proof",
          requestStop: async () => {
            rootObserved = await directoryExists(runRoot);
            exited.resolve();
          },
          forceStop: () => exited.resolve(),
          waitForExit: () => exited.promise,
        });
      },
      {
        cleanupStale: async () => undefined,
        create,
      },
    );
    expect(rootObserved).toBe(true);
    expect(await directoryExists(runRoot)).toBe(false);
  });

  it("delegates usage inspection to the owned run workspace", async () => {
    const owned = await create();
    const workspace = adaptPluginWorkspace(owned);
    try {
      expect(
        (
          await workspace.inspectUsage({
            byteLimit: 1024 * 1024,
            entryLimit: 100,
            scanLimit: 101,
          })
        ).state,
      ).toBe("within");
    } finally {
      await workspace.close();
    }
  });

  it("fails closed before Windows process-group supervision", () => {
    expect(() => assertSupervisorPlatform("win32")).toThrow(
      "requires POSIX process-group ownership",
    );
  });

  it("removes a TERM-resistant descendant after an invalid IPC message", async () => {
    if (process.platform === "win32") return;
    const installerRoot = await outside.temporaryRoot("protocol-failure");
    const recordPath = join(installerRoot, "processes.json");
    let runRoot = "";
    await expect(
      withPluginWorkspaceUsing(
        async (workspace) => {
          runRoot = workspace.path();
          await runInstallerHelpUsing(installerRoot, workspace, {
            source: invalidProtocolSupervisor(recordPath),
          });
        },
        {
          cleanupStale: async () => undefined,
          create,
        },
      ),
    ).rejects.toThrow("Packaged installer runtime validation failed.");
    const record = (await Bun.file(recordPath).json()) as {
      descendant: number;
      supervisor: number;
    };
    expect(processGroupExists(record.supervisor)).toBe(false);
    expect(processExists(record.descendant)).toBe(false);
    expect(await directoryExists(runRoot)).toBe(false);
  });

  it("keeps the guardian live when the staged CLI kills its worker parent", async () => {
    if (process.platform === "win32") return;
    const installerRoot = await outside.temporaryRoot("worker-kill");
    const recordPath = join(installerRoot, "processes.json");
    await write(installerRoot, "src/cli.ts", workerKillingCli(recordPath));
    let runRoot = "";
    await expect(
      withPluginWorkspaceUsing(
        async (workspace) => {
          runRoot = workspace.path();
          await runInstallerHelp(installerRoot, workspace);
        },
        {
          cleanupStale: async () => undefined,
          create,
        },
      ),
    ).rejects.toThrow("Packaged installer runtime validation failed.");
    const record = (await Bun.file(recordPath).json()) as {
      descendant: number;
      group: number;
      tool: number;
      worker: number;
    };
    expect(processGroupExists(record.group)).toBe(false);
    expect(processExists(record.worker)).toBe(false);
    expect(processExists(record.tool)).toBe(false);
    expect(processExists(record.descendant)).toBe(false);
    expect(await directoryExists(runRoot)).toBe(false);
  });

  it("never signals a numeric group after guardian exit is observed", () => {
    let calls = 0;
    const kill = (() => {
      calls += 1;
      return true;
    }) as typeof process.kill;
    expect(signalOwnedGuardian(true, 4242, "SIGKILL", kill)).toBe(false);
    expect(calls).toBe(0);
  });

  it("keeps close rejection primary while retaining both failures", async () => {
    const closeError = new Error("close rejected");
    const operationError = new Error("operation rejected");
    const signal = new AbortController().signal;
    const owned: RunWorkspace = {
      signal,
      path: () => "/unused-test-workspace",
      inspectUsage: () =>
        Promise.reject(new Error("unexpected usage inspection")),
      registerChild: () => undefined,
      preserve: async () => undefined,
      close: () => Promise.reject(closeError),
    };
    let rejection: unknown;
    try {
      await withPluginWorkspaceUsing(() => Promise.reject(operationError), {
        cleanupStale: async () => undefined,
        create: async () => owned,
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(PackagingError);
    expect((rejection as Error).message).toContain("cleanup failed");
    const cause = (rejection as Error).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([
      closeError,
      operationError,
    ]);
  });
});

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function invalidProtocolSupervisor(recordPath: string): string {
  return String.raw`
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 2_147_483_647);
const descendant = Bun.spawn(
  [process.execPath, "--eval", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);"],
  { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
);
await Bun.write(${JSON.stringify(
    recordPath,
  )}, JSON.stringify({ supervisor: process.pid, descendant: descendant.pid }));
process.send?.({ type: "invalid", unexpected: true });
`;
}

function workerKillingCli(recordPath: string): string {
  return String.raw`
if (import.meta.main) {
  process.on("SIGTERM", () => undefined);
  const descendant = Bun.spawn(
    [process.execPath, "--eval", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);"],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const groupResult = Bun.spawnSync(
    ["/bin/ps", "-o", "pgid=", "-p", String(process.pid)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const group = Number(new TextDecoder().decode(groupResult.stdout).trim());
  await Bun.write(
    ${JSON.stringify(recordPath)},
    JSON.stringify({ group, worker: process.ppid, tool: process.pid, descendant: descendant.pid }),
  );
  process.kill(process.ppid, "SIGKILL");
  setInterval(() => undefined, 1000);
}
`;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
