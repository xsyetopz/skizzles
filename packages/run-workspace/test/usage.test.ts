import { describe, expect, it } from "bun:test";
import {
  link,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  MeasuredWorkspaceUsage,
  WorkspaceUsage,
  WorkspaceUsageLimits,
} from "../src/api.ts";
import { createWithRuntime } from "../src/lifecycle.ts";
import {
  markerName,
  type Runtime,
  type UsageDirectory,
} from "../src/platform.ts";
import { runtimeWith, withHarness } from "./support.ts";

const generousByteLimit = 1024 * 1024;
const generousEntryLimit = 1024;
const generousScanLimit = generousEntryLimit + 1;
const targetPayload = "x".repeat(128 * 1024);

const generousLimits: WorkspaceUsageLimits = {
  byteLimit: generousByteLimit,
  entryLimit: generousEntryLimit,
  scanLimit: generousScanLimit,
};

function measured(usage: WorkspaceUsage): MeasuredWorkspaceUsage {
  if ("code" in usage) {
    throw new Error("Expected measured workspace usage");
  }
  return usage;
}

function exactLimits(usage: WorkspaceUsage): WorkspaceUsageLimits {
  const selected = measured(usage);
  return {
    byteLimit: Math.max(selected.logicalBytes, selected.allocatedBytes),
    entryLimit: selected.entryCount,
    scanLimit: selected.entryCount,
  };
}

function descriptorRuntime(
  base: Runtime,
  overrides: Partial<Runtime> = {},
  beforeOpen: (path: string) => Promise<void> = () => Promise.resolve(),
): Runtime {
  let selected = runtimeWith(base, overrides);
  const openDirectory = async (
    path: string,
  ): Promise<UsageDirectory | undefined> => {
    await beforeOpen(path);
    const entry = await selected.lstatUsage(path);
    if (entry?.kind !== "directory") {
      return;
    }
    return {
      entry,
      scan: (limit) => selected.scanDirectory(path, limit),
      inspect: (name) => selected.lstatUsage(join(path, name)),
      open: (name) => openDirectory(join(path, name)),
      stat: () => selected.lstatUsage(path),
      close: () => Promise.resolve(),
    } satisfies UsageDirectory;
  };
  selected = runtimeWith(selected, {
    openUsageDirectory: openDirectory,
  });
  return selected;
}

describe("run workspace usage", () => {
  it("passes exact limits and exceeds byte or entry one-over boundaries", async () => {
    await withHarness(async (base) => {
      const runtime = descriptorRuntime(base);
      const workspace = await createWithRuntime({}, runtime);
      const baseline = measured(await workspace.inspectUsage(generousLimits));
      expect(baseline.state).toBe("within");
      const exact = exactLimits(baseline);
      expect((await workspace.inspectUsage(exact)).state).toBe("within");

      await writeFile(workspace.path("one-over"), "x");
      const byteExceeded = measured(
        await workspace.inspectUsage({
          ...exact,
          entryLimit: generousEntryLimit,
          scanLimit: generousScanLimit,
        }),
      );
      expect(byteExceeded.state).toBe("exceeded");

      const current = measured(await workspace.inspectUsage(generousLimits));
      const entryExact = exactLimits(current);
      await link(workspace.path("one-over"), workspace.path("hard-link"));
      const entryExceeded = measured(
        await workspace.inspectUsage({
          ...entryExact,
          byteLimit: generousByteLimit,
          scanLimit: entryExact.scanLimit + 1,
        }),
      );
      expect(entryExceeded.state).toBe("exceeded");
      expect(entryExceeded.entryCount).toBe(current.entryCount + 1);
      expect(entryExceeded.logicalBytes).toBe(current.logicalBytes);
      expect(entryExceeded.allocatedBytes).toBe(current.allocatedBytes);
      await workspace.close();
    });
  });

  it("does not follow symlinks or inspect foreign siblings", async () => {
    await withHarness(async (base, fixtureRoot) => {
      const workspace = await createWithRuntime({}, descriptorRuntime(base));
      const before = measured(await workspace.inspectUsage(generousLimits));
      const foreign = join(fixtureRoot, "foreign-sibling");
      await mkdir(foreign);
      await writeFile(join(foreign, "large-target"), targetPayload);
      expect(await workspace.inspectUsage(generousLimits)).toEqual(before);

      await symlink(foreign, workspace.path("foreign-link"));
      const linked = measured(await workspace.inspectUsage(generousLimits));
      expect(linked.state).toBe("within");
      expect(linked.entryCount).toBe(before.entryCount + 1);
      expect(linked.logicalBytes - before.logicalBytes).toBeLessThan(
        targetPayload.length,
      );
      expect((await workspace.close()).state).toBe("deleted");
      expect(await readFile(join(foreign, "large-target"), "utf8")).toBe(
        targetPayload,
      );
    });
  });

  it("never inspects a foreign target when a directory becomes a symlink", async () => {
    await withHarness(async (base, fixtureRoot) => {
      let victim = "";
      let displaced = "";
      let swapped = false;
      let foreignCalls = 0;
      const foreign = join(fixtureRoot, "foreign-target");
      await mkdir(foreign);
      await writeFile(join(foreign, "sentinel"), targetPayload);
      const runtime = descriptorRuntime(
        base,
        {
          lstatUsage: async (path) => {
            if (path.startsWith(`${foreign}/`)) {
              foreignCalls += 1;
            }
            return base.lstatUsage(path);
          },
          scanDirectory: async (path, limit) => {
            if (path === foreign || path.startsWith(`${foreign}/`)) {
              foreignCalls += 1;
            }
            return base.scanDirectory(path, limit);
          },
        },
        async (path) => {
          if (path === victim && !swapped) {
            swapped = true;
            await rename(victim, displaced);
            await symlink(foreign, victim);
          }
        },
      );
      const workspace = await createWithRuntime({}, runtime);
      victim = workspace.path("victim");
      displaced = workspace.path("victim-original");
      await mkdir(victim);
      await writeFile(join(victim, "owned"), "owned");

      expect((await workspace.inspectUsage(generousLimits)).state).toBe(
        "unknown",
      );
      expect(swapped).toBeTrue();
      expect(foreignCalls).toBe(0);
      expect((await workspace.close()).state).toBe("deleted");
    });
  });

  it("rejects a Darwin symlink swap through the native directory descriptor", async () => {
    await withHarness(async (base, fixtureRoot) => {
      if (base.platform !== "darwin") {
        return;
      }
      let victim = "";
      let displaced = "";
      let swapped = false;
      let foreignCalls = 0;
      const foreign = join(fixtureRoot, "native-foreign-target");
      await mkdir(foreign);
      await writeFile(join(foreign, "sentinel"), targetPayload);

      const wrap = (
        directory: UsageDirectory,
        foreignScope: boolean,
      ): UsageDirectory => ({
        entry: directory.entry,
        scan: async (limit) => {
          if (foreignScope) {
            foreignCalls += 1;
          }
          return directory.scan(limit);
        },
        inspect: async (name) => {
          if (foreignScope) {
            foreignCalls += 1;
          }
          return directory.inspect(name);
        },
        open: async (name) => {
          let childIsForeign = foreignScope;
          if (!swapped && name === "victim") {
            swapped = true;
            childIsForeign = true;
            await rename(victim, displaced);
            await symlink(foreign, victim);
          }
          const child = await directory.open(name);
          return child === undefined ? undefined : wrap(child, childIsForeign);
        },
        stat: () => directory.stat(),
        close: () => directory.close(),
      });
      const runtime = runtimeWith(base, {
        openUsageDirectory: async (path) => {
          const directory = await base.openUsageDirectory(path);
          return directory === undefined ? undefined : wrap(directory, false);
        },
      });
      const workspace = await createWithRuntime({}, runtime);
      victim = workspace.path("victim");
      displaced = workspace.path("victim-original");
      await mkdir(victim);
      await writeFile(join(victim, "owned"), "owned");

      expect((await workspace.inspectUsage(generousLimits)).state).toBe(
        "unknown",
      );
      expect(swapped).toBeTrue();
      expect(foreignCalls).toBe(0);
      expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe(
        targetPayload,
      );
      expect((await workspace.close()).state).toBe("deleted");
    });
  });

  it("returns unknown for unreadable, raced, truncated, and replaced state", async () => {
    await withHarness(async (base, fixtureRoot) => {
      let unreadablePath = "";
      let racedPath = "";
      let raceObservations = 0;
      const runtime = descriptorRuntime(base, {
        lstatUsage: async (path) => {
          if (path === unreadablePath) {
            return;
          }
          const entry = await base.lstatUsage(path);
          if (path !== racedPath || entry === undefined) {
            return entry;
          }
          raceObservations += 1;
          if (raceObservations === 2) {
            return {
              ...entry,
              modifiedTimeNs: `${BigInt(entry.modifiedTimeNs) + 1n}`,
            };
          }
          return entry;
        },
      });
      const workspace = await createWithRuntime({}, runtime);
      unreadablePath = workspace.path("unreadable");
      await writeFile(unreadablePath, "private");
      expect((await workspace.inspectUsage(generousLimits)).state).toBe(
        "unknown",
      );
      unreadablePath = "";
      racedPath = workspace.path("raced");
      await writeFile(racedPath, "changing");
      expect((await workspace.inspectUsage(generousLimits)).state).toBe(
        "unknown",
      );
      racedPath = "";
      expect(
        (
          await workspace.inspectUsage({
            byteLimit: generousByteLimit,
            entryLimit: generousEntryLimit,
            scanLimit: 0,
          })
        ).state,
      ).toBe("unknown");

      const root = workspace.path();
      const displacedRoot = join(fixtureRoot, "displaced-usage-root");
      const marker = await readFile(join(root, markerName), "utf8");
      await rename(root, displacedRoot);
      await mkdir(root);
      await writeFile(join(root, markerName), marker, { mode: 0o600 });
      expect((await workspace.inspectUsage(generousLimits)).state).toBe(
        "unknown",
      );
      expect((await workspace.close()).state).toBe("cleanup-failed");
    });
  });

  it("returns typed invalid results without invoking accessors or scanning", async () => {
    await withHarness(async (base) => {
      let usageCalls = 0;
      const runtime = descriptorRuntime(base, {
        lstatUsage: async (path) => {
          usageCalls += 1;
          return base.lstatUsage(path);
        },
      });
      const workspace = await createWithRuntime({}, runtime);
      let getterCalls = 0;
      const accessor = {
        entryLimit: generousEntryLimit,
        scanLimit: generousScanLimit,
      };
      Object.defineProperty(accessor, "byteLimit", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return generousByteLimit;
        },
      });
      let proxyCalls = 0;
      const hostile = new Proxy(generousLimits, {
        ownKeys: () => {
          proxyCalls += 1;
          throw new Error("must not inspect hostile proxy");
        },
      });
      const symbolKey = { ...generousLimits, [Symbol("extra")]: true };
      const invalid = {
        state: "unknown",
        code: "INVALID_USAGE_LIMIT",
        logicalBytes: 0,
        allocatedBytes: 0,
        entryCount: 0,
      } as const;
      for (const value of [
        undefined,
        null,
        { ...generousLimits, byteLimit: -1 },
        { ...generousLimits, scanLimit: 1_000_001 },
        { ...generousLimits, extra: 1 },
        accessor,
        hostile,
        symbolKey,
      ]) {
        expect(await workspace.inspectUsage(value)).toEqual(invalid);
      }
      expect(getterCalls).toBe(0);
      expect(proxyCalls).toBe(0);
      expect(usageCalls).toBe(0);
      await workspace.close();
    });
  });

  it("works through the native descriptor adapter or fails closed when unsupported", async () => {
    await withHarness(async (base) => {
      const workspace = await createWithRuntime({}, descriptorRuntime(base));
      await workspace.close();
      expect(await workspace.inspectUsage(generousLimits)).toEqual({
        state: "unknown",
        logicalBytes: 0,
        allocatedBytes: 0,
        entryCount: 0,
        ...generousLimits,
      });

      const native = await createWithRuntime({}, base);
      if (base.platform === "darwin") {
        const probe = await base.openUsageDirectory(native.path());
        expect(probe).toBeDefined();
        if (probe !== undefined) {
          expect((await probe.scan(generousScanLimit)).truncated).toBeFalse();
          await probe.close();
        }
      }
      const nativeUsage = await native.inspectUsage(generousLimits);
      if (base.platform === "darwin" || base.platform === "linux") {
        expect(nativeUsage.state).toBe("within");
      } else {
        expect(nativeUsage.state).toBe("unknown");
      }
      await native.close();
    });
  });
});
