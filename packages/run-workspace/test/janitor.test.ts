import { describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { cleanupStaleWithRuntime } from "../src/janitor.ts";
import { createWithRuntime } from "../src/lifecycle.ts";
import { markerPath, readMarker, serializeMarker } from "../src/marker.ts";
import type { ProcessIdentity, Runtime } from "../src/platform.ts";
import { managedParent, markerName } from "../src/platform.ts";
import { runtimeWith, withHarness } from "./support.ts";

async function oldWorkspace(
  runtime: Runtime,
): Promise<{ root: string; identity: ProcessIdentity }> {
  const identity = await runtime.processIdentity(runtime.pid);
  if (identity === undefined) {
    throw new Error("Process identity unavailable in test");
  }
  const creation = runtimeWith(runtime, { now: () => 1 });
  const workspace = await createWithRuntime({}, creation);
  return { root: workspace.path(), identity };
}

function cleanupRuntime(
  runtime: Runtime,
  processIdentity: Runtime["processIdentity"],
  processExists: Runtime["processExists"],
): Runtime {
  return runtimeWith(runtime, {
    now: () => 10_000,
    processIdentity,
    processExists,
  });
}

describe("stale workspace cleanup", () => {
  it("fails closed before scanning an unsafe managed parent", async () => {
    await withHarness(async (runtime, fixtureRoot) => {
      const parent = managedParent(runtime);
      const target = join(fixtureRoot, "unsafe-parent-target");
      await mkdir(target, { mode: 0o700 });
      let cleaning = runtime;
      if (process.platform === "win32") {
        cleaning = runtimeWith(runtime, {
          lstatIdentity: async (path) => {
            if (path === parent) return undefined;
            return runtime.lstatIdentity(path);
          },
        });
      } else {
        await symlink(target, parent);
      }
      let removals = 0;
      cleaning = runtimeWith(cleaning, {
        removeRoot: async (path) => {
          removals += 1;
          await runtime.removeRoot(path);
        },
      });

      const report = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        cleaning,
      );
      expect(report).toEqual({
        deleted: [],
        skipped: [],
        failed: [
          { rootName: "skizzles-run-workspaces", error: "CLEANUP_FAILED" },
        ],
        truncated: false,
      });
      expect(removals).toBe(0);
    });
  });

  it("deletes definite dead owners and PID-reused owners", async () => {
    await withHarness(async (runtime) => {
      const dead = await oldWorkspace(runtime);
      const deadRuntime = cleanupRuntime(
        runtime,
        async () => undefined,
        async () => false,
      );
      const deadReport = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        deadRuntime,
      );
      expect(deadReport.deleted).toContain(basenameOf(dead.root));

      const reused = await oldWorkspace(runtime);
      const replacement: ProcessIdentity = {
        ...reused.identity,
        token: `${reused.identity.token}:reused`,
      };
      const reusedRuntime = cleanupRuntime(
        runtime,
        async () => replacement,
        async () => true,
      );
      const reusedReport = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        reusedRuntime,
      );
      expect(reusedReport.deleted).toContain(basenameOf(reused.root));
    });
  });

  it("skips live, unknown, and preserved owners", async () => {
    await withHarness(async (runtime) => {
      const live = await oldWorkspace(runtime);
      const liveRuntime = cleanupRuntime(
        runtime,
        async () => live.identity,
        async () => true,
      );
      const liveReport = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        liveRuntime,
      );
      expect(liveReport.skipped).toContainEqual({
        rootName: basenameOf(live.root),
        reason: "live-owner",
      });

      const unknown = await oldWorkspace(runtime);
      const unknownRuntime = cleanupRuntime(
        runtime,
        async () => undefined,
        async () => true,
      );
      const unknownReport = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        unknownRuntime,
      );
      expect(unknownReport.skipped).toContainEqual({
        rootName: basenameOf(unknown.root),
        reason: "unknown-owner",
      });

      const preservedCreation = runtimeWith(runtime, { now: () => 1 });
      const preserved = await createWithRuntime({}, preservedCreation);
      const preservedRoot = preserved.path();
      await preserved.preserve("explicit diagnostic retention");
      const preservedRuntime = cleanupRuntime(
        runtime,
        async () => undefined,
        async () => false,
      );
      const preservedReport = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        preservedRuntime,
      );
      expect(preservedReport.skipped).toContainEqual({
        rootName: basenameOf(preservedRoot),
        reason: "preserved",
      });
    });
  });

  it("does not authorize deletion from a valid marker in an insecure candidate", async () => {
    await withHarness(async (runtime) => {
      const stale = await oldWorkspace(runtime);
      if (process.platform !== "win32") await chmod(stale.root, 0o755);
      let removals = 0;
      const cleaning = runtimeWith(
        cleanupRuntime(
          runtime,
          async () => undefined,
          async () => false,
        ),
        {
          isPrivateDirectory: async (path) => {
            if (path === stale.root) return false;
            return runtime.isPrivateDirectory(path);
          },
          removeRoot: async (path) => {
            removals += 1;
            await runtime.removeRoot(path);
          },
        },
      );
      const report = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        cleaning,
      );
      expect(report.deleted).toHaveLength(0);
      expect(report.failed).toHaveLength(0);
      expect(report.skipped).toContainEqual({
        rootName: basenameOf(stale.root),
        reason: "identity-mismatch",
      });
      expect(removals).toBe(0);
    });
  });

  it("rejects unmarked, oversized, duplicate-key, and insecure markers", async () => {
    await withHarness(async (runtime) => {
      const parent = managedParent(runtime);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      const unmarked = join(parent, "run-unmarked");
      await mkdir(unmarked);

      const valid = await oldWorkspace(runtime);
      const validContents = await readFile(markerPath(valid.root), "utf8");

      const oversized = join(parent, "run-oversized");
      await mkdir(oversized);
      await writeFile(join(oversized, markerName), "x".repeat(20_000), {
        mode: 0o600,
      });

      const duplicate = join(parent, "run-duplicate");
      await mkdir(duplicate);
      await writeFile(
        join(duplicate, markerName),
        validContents.replace("{\n", '{\n  "schema": 1,\n'),
        {
          mode: 0o600,
        },
      );

      const insecure = join(parent, "run-insecure");
      await mkdir(insecure);
      await writeFile(join(insecure, markerName), validContents, {
        mode: 0o644,
      });
      await chmod(join(insecure, markerName), 0o644);

      const report = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        cleanupRuntime(
          runtime,
          async () => undefined,
          async () => false,
        ),
      );
      expect(report.skipped).toContainEqual({
        rootName: "run-unmarked",
        reason: "unmarked",
      });
      for (const rootName of [
        "run-oversized",
        "run-duplicate",
        "run-insecure",
      ]) {
        expect(report.skipped).toContainEqual({
          rootName,
          reason: "malformed-marker",
        });
      }
    });
  });

  it("bounds scan work and reports truncation once", async () => {
    await withHarness(async (runtime) => {
      const parent = managedParent(runtime);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      for (const suffix of ["a", "b", "c"]) {
        await mkdir(join(parent, `run-${suffix}`));
      }
      const report = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0, scanLimit: 1 },
        runtime,
      );
      expect(report.truncated).toBeTrue();
      expect(report.skipped).toHaveLength(1);
    });
  });

  it("recognizes concurrent duplicate cleanup without a false failure", async () => {
    await withHarness(async (runtime) => {
      const cleaning = cleanupRuntime(
        runtime,
        async () => undefined,
        async () => false,
      );
      for (let round = 0; round < 20; round += 1) {
        const stale = await oldWorkspace(runtime);
        const reports = await Promise.all(
          Array.from({ length: 12 }, () =>
            cleanupStaleWithRuntime({ minimumAgeMs: 0 }, cleaning),
          ),
        );
        expect(reports.flatMap((report) => report.deleted)).toEqual([
          basenameOf(stale.root),
        ]);
        expect(reports.flatMap((report) => report.failed)).toHaveLength(0);
      }
    });
  });

  it("recovers a crash after claim rename and before marker rewrite", async () => {
    await withHarness(async (runtime) => {
      const stale = await oldWorkspace(runtime);
      const marker = await readMarker(runtime, stale.root);
      if (marker === undefined) throw new Error("Expected marker");
      const interruptedClaim = join(
        managedParent(runtime),
        `reaping-${marker.runId}-${crypto.randomUUID()}`,
      );
      await rename(stale.root, interruptedClaim);

      const cleaning = cleanupRuntime(
        runtime,
        async () => undefined,
        async () => false,
      );
      const report = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        cleaning,
      );
      expect(report.deleted).toContain(basenameOf(interruptedClaim));
      expect(report.failed).toHaveLength(0);
      expect(
        (await runtime.readdir(managedParent(runtime))).filter((name) =>
          name.startsWith("reaping-"),
        ),
      ).toHaveLength(0);
    });
  });

  it("retains cleanup failures and retries Windows-style locked files", async () => {
    await withHarness(async (runtime) => {
      const stale = await oldWorkspace(runtime);
      const cleaning = cleanupRuntime(
        runtime,
        async () => undefined,
        async () => false,
      );
      const locked = runtimeWith(cleaning, {
        removeRoot: async () => {
          const error = new Error("locked");
          Object.defineProperty(error, "code", { value: "EBUSY" });
          throw error;
        },
      });
      const failed = await cleanupStaleWithRuntime({ minimumAgeMs: 0 }, locked);
      expect(failed.failed).toContainEqual({
        rootName: basenameOf(stale.root),
        error: "CLEANUP_FAILED",
      });
      const retainedName = (await runtime.readdir(managedParent(runtime))).find(
        (name) => name.startsWith("reaping-"),
      );
      expect(retainedName).toBeDefined();
      const retried = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        cleaning,
      );
      expect(
        retried.deleted.some((name) => name.startsWith("reaping-")),
      ).toBeTrue();
    });
  });

  it("cleans a workspace owned by a process that really exited", async () => {
    await withHarness(async (runtime) => {
      const child = Bun.spawn(
        [process.execPath, "-e", "await Bun.sleep(100)"],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const childIdentity = await runtime.processIdentity(child.pid);
      if (childIdentity === undefined) {
        child.kill();
        await child.exited;
        return;
      }
      const stale = await oldWorkspace(runtime);
      const marker = await readMarker(runtime, stale.root);
      if (marker === undefined) throw new Error("Expected marker");
      await runtime.writeReplace(
        markerPath(stale.root),
        serializeMarker({
          ...marker,
          ownerPid: child.pid,
          ownerIdentity: childIdentity,
        }),
      );
      await child.exited;
      const report = await cleanupStaleWithRuntime(
        { minimumAgeMs: 0 },
        runtimeWith(runtime, { now: () => 10_000 }),
      );
      expect(report.deleted).toContain(basenameOf(stale.root));
    });
  });
});

function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/u);
  return segments.at(-1) ?? "";
}
