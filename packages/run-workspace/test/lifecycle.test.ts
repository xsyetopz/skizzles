// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, it } from "bun:test";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import { createWithRuntime } from "../src/lifecycle.ts";
import { readMarker } from "../src/marker.ts";
import { markerName } from "../src/platform.ts";
import { deferred, runtimeWith, withHarness } from "./support.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("run workspace lifecycle", () => {
  it("creates one marked root and deletes the complete root on normal close", async () => {
    await withHarness(async (runtime) => {
      const removed: string[] = [];
      const instrumented = runtimeWith(runtime, {
        removeRoot: async (path) => {
          removed.push(path);
          await runtime.removeRoot(path);
        },
      });
      const workspace = await createWithRuntime({}, instrumented);
      const root = workspace.path();
      for (const name of [".codex", ".gradle", "build", "Downloads"]) {
        await mkdir(workspace.path(name), { recursive: true });
      }
      expect(await exists(join(root, markerName))).toBeTrue();
      const first = workspace.close();
      const second = workspace.close();
      expect(first).toBe(second);
      const report = await first;
      expect(report.state).toBe("deleted");
      expect(await exists(root)).toBeFalse();
      expect(removed).toHaveLength(1);
      expect(basename(removed[0] ?? "").startsWith("reaping-")).toBeTrue();
      expect(
        removed.some((path) =>
          [".codex", ".gradle", "build", "Downloads"].includes(basename(path)),
        ),
      ).toBeFalse();
    });
  });

  it("rejects empty, absolute, NUL, and traversal paths", async () => {
    await withHarness(async (runtime) => {
      const workspace = await createWithRuntime({}, runtime);
      expect(() => workspace.path("")).toThrow();
      expect(() => workspace.path("../outside")).toThrow();
      expect(() => workspace.path("a/../outside")).toThrow();
      expect(() => workspace.path("/outside")).toThrow();
      expect(() => workspace.path("C:\\outside")).toThrow();
      expect(() => workspace.path("nul\0byte")).toThrow();
      await workspace.close();
    });
  });

  it("supports exception-safe finally cleanup", async () => {
    await withHarness(async (runtime) => {
      let root = "";
      try {
        const workspace = await createWithRuntime({}, runtime);
        root = workspace.path();
        try {
          throw new Error("operation failed");
        } finally {
          await workspace.close();
        }
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(await exists(root)).toBeFalse();
    });
  });

  it("abort cancellation exposes a signal and closes the workspace", async () => {
    await withHarness(async (runtime) => {
      const cancellation = new AbortController();
      const workspace = await createWithRuntime(
        { signal: cancellation.signal },
        runtime,
      );
      const root = workspace.path();
      cancellation.abort();
      const report = await workspace.close();
      expect(workspace.signal.aborted).toBeTrue();
      expect(report.state).toBe("deleted");
      expect(await exists(root)).toBeFalse();
    });
  });

  it("closes and rejects when abort occurs during listener registration", async () => {
    await withHarness(async (runtime) => {
      const controller = new AbortController();
      const nativeSignal = controller.signal;
      const nativeAdd = nativeSignal.addEventListener.bind(nativeSignal);
      const nativeRemove = nativeSignal.removeEventListener.bind(nativeSignal);
      let removals = 0;
      const add: AbortSignal["addEventListener"] = (
        type,
        listener,
        options,
      ) => {
        nativeAdd(type, listener, options);
        controller.abort();
      };
      const remove: AbortSignal["removeEventListener"] = (
        type,
        listener,
        options,
      ) => {
        removals += 1;
        nativeRemove(type, listener, options);
      };
      const signal = new Proxy(nativeSignal, {
        get: (target, property) => {
          if (property === "addEventListener") return add;
          if (property === "removeEventListener") return remove;
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      let createdRoot = "";
      const controlled = runtimeWith(runtime, {
        mkdtemp: async (prefix) => {
          createdRoot = await runtime.mkdtemp(prefix);
          return createdRoot;
        },
      });

      await expect(
        createWithRuntime({ signal }, controlled),
      ).rejects.toBeInstanceOf(Error);
      expect(signal.aborted).toBeTrue();
      expect(removals).toBe(1);
      expect(await exists(createdRoot)).toBeFalse();
    });
  });

  it("timeout cancellation closes the workspace", async () => {
    await withHarness(async (runtime) => {
      const timeout = new AbortController();
      const workspace = await createWithRuntime(
        { signal: timeout.signal },
        runtime,
      );
      const root = workspace.path();
      setTimeout(() => timeout.abort(), 5);
      await Bun.sleep(10);
      expect((await workspace.close()).state).toBe("deleted");
      expect(await exists(root)).toBeFalse();
    });
  });

  it("uses reverse stop order and forces unresolved children before root deletion", async () => {
    await withHarness(async (runtime) => {
      const events: string[] = [];
      const firstExit = deferred();
      const secondExit = deferred();
      const workspace = await createWithRuntime(
        { gracefulStopMs: 5, forceStopMs: 50 },
        runtime,
      );
      const root = workspace.path();
      workspace.registerChild({
        label: "first",
        requestStop: () => {
          events.push("request:first");
        },
        forceStop: () => {
          events.push("force:first");
          firstExit.resolve();
        },
        waitForExit: () => firstExit.promise,
      });
      workspace.registerChild({
        label: "second",
        requestStop: () => {
          events.push("request:second");
        },
        forceStop: () => {
          events.push("force:second");
          secondExit.resolve();
        },
        waitForExit: () => secondExit.promise,
      });
      const report = await workspace.close();
      expect(events).toEqual([
        "request:second",
        "request:first",
        "force:second",
        "force:first",
      ]);
      expect(
        report.children.every((child) => child.stopped && child.forced),
      ).toBeTrue();
      expect(await exists(root)).toBeFalse();
    });
  });

  it("retains on unconfirmed child failure and permits a cleanup retry", async () => {
    await withHarness(async (runtime) => {
      const exit = deferred();
      const workspace = await createWithRuntime(
        { gracefulStopMs: 1, forceStopMs: 1 },
        runtime,
      );
      const root = workspace.path();
      workspace.registerChild({
        label: "stuck",
        requestStop: () => undefined,
        forceStop: () => undefined,
        waitForExit: () => exit.promise,
      });
      const failed = await workspace.close();
      expect(failed.state).toBe("cleanup-failed");
      expect(failed.error).toBe("CHILD_UNCONFIRMED");
      expect(await exists(root)).toBeTrue();
      exit.resolve();
      const retried = await workspace.close();
      expect(retried.state).toBe("deleted");
      expect(await exists(root)).toBeFalse();
    });
  });

  it("normalizes throwing child adapters and permits a confirmed retry", async () => {
    await withHarness(async (runtime) => {
      let confirmsExit = false;
      const workspace = await createWithRuntime(
        { gracefulStopMs: 1, forceStopMs: 1 },
        runtime,
      );
      const root = workspace.path();
      workspace.registerChild({
        label: "throwing-adapter",
        requestStop: () => {
          throw new Error("synchronous stop failure");
        },
        forceStop: () =>
          Promise.reject(new Error("asynchronous force failure")),
        waitForExit: () => {
          if (!confirmsExit)
            throw new Error("synchronous exit observation failure");
          return Promise.resolve();
        },
      });

      const failed = await workspace.close();
      expect(failed.state).toBe("cleanup-failed");
      expect(failed.error).toBe("CHILD_UNCONFIRMED");
      expect(failed.children).toContainEqual({
        label: "throwing-adapter",
        stopped: false,
        forced: true,
        error: "FORCE_STOP_FAILED",
      });
      expect(await exists(root)).toBeTrue();

      confirmsExit = true;
      const retried = await workspace.close();
      expect(retried.state).toBe("deleted");
      expect(await exists(root)).toBeFalse();
    });
  });

  it("preservation remains opt-in and happens after child shutdown", async () => {
    await withHarness(async (runtime) => {
      const exit = deferred();
      const events: string[] = [];
      const workspace = await createWithRuntime(
        { gracefulStopMs: 20 },
        runtime,
      );
      const root = workspace.path();
      workspace.registerChild({
        label: "preserved-child",
        requestStop: () => {
          events.push("stopped");
          exit.resolve();
        },
        forceStop: () => undefined,
        waitForExit: () => exit.promise,
      });
      await workspace.preserve("explicit evidence retention");
      const report = await workspace.close();
      expect(report.state).toBe("preserved");
      expect(events).toEqual(["stopped"]);
      expect(await exists(root)).toBeTrue();
    });
  });

  it("serializes preservation with close and never deletes a preserved root", async () => {
    await withHarness(async (runtime) => {
      const published = deferred();
      const releasePublication = deferred();
      const childExit = deferred();
      let childStopped = false;
      let removals = 0;
      const controlled = runtimeWith(runtime, {
        writeReplace: async (path, contents) => {
          await runtime.writeReplace(path, contents);
          if (contents.includes('"state": "preserved"')) {
            published.resolve();
            await releasePublication.promise;
          }
        },
        removeRoot: async (path) => {
          removals += 1;
          await runtime.removeRoot(path);
        },
      });
      const workspace = await createWithRuntime({}, controlled);
      const root = workspace.path();
      workspace.registerChild({
        label: "preservation-child",
        requestStop: () => {
          childStopped = true;
          childExit.resolve();
        },
        forceStop: () => undefined,
        waitForExit: () => childExit.promise,
      });

      const preservation = workspace.preserve("retained interleaving evidence");
      await published.promise;
      const closing = workspace.close();
      let closeSettled = false;
      closing
        .then(() => {
          closeSettled = true;
        })
        .catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(childStopped).toBeTrue();
      expect(closeSettled).toBeFalse();
      expect(removals).toBe(0);
      expect(await exists(root)).toBeTrue();

      releasePublication.resolve();
      await preservation;
      const report = await closing;
      expect(report.state).toBe("preserved");
      expect(report.children[0]?.stopped).toBeTrue();
      expect(removals).toBe(0);
      expect(await exists(root)).toBeTrue();
    });
  });

  it("cancels losing deadlines so an empty close does not retain the process", async () => {
    if (process.platform === "win32") return;
    const source = [
      'import { create } from "@skizzles/run-workspace";',
      "const workspace = await create({ gracefulStopMs: 2000, forceStopMs: 2000 });",
      "const report = await workspace.close();",
      "if (report.state !== 'deleted') throw new Error('close failed');",
    ].join("\n");
    const startedAt = performance.now();
    const child = Bun.spawn([process.execPath, "-e", source], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it("retains a claimed root on deletion failure and retries from that root", async () => {
    await withHarness(async (runtime) => {
      let attempts = 0;
      const locked = runtimeWith(runtime, {
        removeRoot: async (path) => {
          attempts += 1;
          if (attempts === 1) throw new Error("simulated locked file");
          await runtime.removeRoot(path);
        },
      });
      const workspace = await createWithRuntime({}, locked);
      const first = await workspace.close();
      expect(first.state).toBe("cleanup-failed");
      expect(first.error).toBe("CLEANUP_FAILED");
      const second = await workspace.close();
      expect(second.state).toBe("deleted");
      expect(attempts).toBe(2);
    });
  });

  it("fails closed after root replacement or symlink substitution", async () => {
    await withHarness(async (runtime, fixtureRoot) => {
      const replaced = await createWithRuntime({}, runtime);
      const replacedRoot = replaced.path();
      const displaced = join(fixtureRoot, "displaced-root");
      const marker = await readFile(join(replacedRoot, markerName), "utf8");
      await rename(replacedRoot, displaced);
      await mkdir(replacedRoot);
      await writeFile(join(replacedRoot, markerName), marker, { mode: 0o600 });
      expect((await replaced.close()).state).toBe("cleanup-failed");
      expect(await exists(replacedRoot)).toBeTrue();

      const linked = await createWithRuntime({}, runtime);
      const linkedRoot = linked.path();
      const linkedDisplaced = join(fixtureRoot, "linked-displaced");
      const target = join(fixtureRoot, "attack-target");
      await mkdir(target);
      await writeFile(join(target, "sentinel"), "keep");
      await rename(linkedRoot, linkedDisplaced);
      await symlink(target, linkedRoot);
      expect((await linked.close()).state).toBe("cleanup-failed");
      expect(await readFile(join(target, "sentinel"), "utf8")).toBe("keep");
    });
  });

  it("marks a residue when initialization and immediate deletion both fail", async () => {
    await withHarness(async (runtime) => {
      let createdRoot = "";
      const failing = runtimeWith(runtime, {
        mkdtemp: async (prefix) => {
          createdRoot = await runtime.mkdtemp(prefix);
          return createdRoot;
        },
        chmod: async (path, mode) => {
          if (path === createdRoot) throw new Error("initialization failure");
          await runtime.chmod(path, mode);
        },
        removeRoot: async (path) => {
          if (path === createdRoot)
            throw new Error("locked initialization residue");
          await runtime.removeRoot(path);
        },
      });
      await expect(createWithRuntime({}, failing)).rejects.toMatchObject({
        code: "INITIALIZATION_FAILED",
      });
      const marker = await readMarker(runtime, createdRoot);
      expect(marker?.state).toBe("cleanup-failed");
      expect(marker?.reason).toBe("INITIALIZATION_FAILED");
    });
  });

  it("does not delete a replacement after initialization authority is lost", async () => {
    await withHarness(async (runtime, fixtureRoot) => {
      let createdRoot = "";
      let swapped = false;
      const displaced = join(fixtureRoot, "displaced-initialization-root");
      const controlled = runtimeWith(runtime, {
        mkdtemp: async (prefix) => {
          createdRoot = await runtime.mkdtemp(prefix);
          return createdRoot;
        },
        isPrivateDirectory: async (path) => {
          if (path === createdRoot && !swapped) {
            swapped = true;
            await rename(path, displaced);
            await mkdir(path, { mode: 0o700 });
            await writeFile(join(path, "foreign-sentinel"), "preserve");
            return false;
          }
          return runtime.isPrivateDirectory(path);
        },
      });

      await expect(createWithRuntime({}, controlled)).rejects.toMatchObject({
        code: "INITIALIZATION_FAILED",
      });
      expect(
        await readFile(join(createdRoot, "foreign-sentinel"), "utf8"),
      ).toBe("preserve");
      expect(await exists(displaced)).toBeTrue();
    });
  });

  it("rejects an insecure managed parent or created root", async () => {
    await withHarness(async (runtime) => {
      const insecureParent = runtimeWith(runtime, {
        isPrivateDirectory: async () => false,
      });
      await expect(createWithRuntime({}, insecureParent)).rejects.toMatchObject(
        { code: "UNSAFE_PARENT" },
      );

      let createdRoot = "";
      const insecureRoot = runtimeWith(runtime, {
        mkdtemp: async (prefix) => {
          createdRoot = await runtime.mkdtemp(prefix);
          return createdRoot;
        },
        isPrivateDirectory: async (path) => {
          if (path === createdRoot) return false;
          return runtime.isPrivateDirectory(path);
        },
      });
      await expect(createWithRuntime({}, insecureRoot)).rejects.toMatchObject({
        code: "UNSAFE_ROOT",
      });
      expect(await exists(createdRoot)).toBeFalse();
    });
  });
});
