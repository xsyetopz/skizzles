import { afterEach, describe, expect, it } from "bun:test";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CatalogRefreshCommitHooks,
  type CatalogRefreshRuntime,
  refreshCatalogWithRuntime,
} from "../../src/catalog/refresh.ts";
import {
  type CodexRuntime,
  systemCodexRuntime,
} from "../../src/codex-child.ts";
import {
  cleanupCatalogRoots,
  createCatalogRoot,
  createFakeCodex,
  source,
} from "./harness.ts";

const fixtures = { cleanup: cleanupCatalogRoots };
afterEach(fixtures.cleanup);

describe("model catalog lifecycle commit boundary", () => {
  it("fails closed on Windows before spawning or mutating persistent files", async () => {
    const root = await createCatalogRoot();
    const paths = persistentPaths(root);
    await Promise.all([
      writeFile(paths.output, "last-output\n", { mode: 0o640 }),
      writeFile(paths.status, "last-status\n", { mode: 0o640 }),
      writeFile(paths.cache, "last-cache\n", { mode: 0o640 }),
    ]);
    await Promise.all([
      chmod(paths.output, 0o640),
      chmod(paths.status, 0o640),
      chmod(paths.cache, 0o640),
    ]);
    let spawns = 0;
    const codex: CodexRuntime = {
      platform: "win32",
      spawn: () => {
        spawns += 1;
        throw new Error("spawn must not be called");
      },
    };

    await expect(
      refreshCatalogWithRuntime(
        { codexHome: root, codexBinary: "/missing/codex", ...paths },
        { codex },
      ),
    ).rejects.toMatchObject({ code: "unsupported-platform" });

    expect(spawns).toBe(0);
    expect(await persistentSnapshot(paths)).toEqual({
      output: ["last-output\n", 0o640],
      status: ["last-status\n", 0o640],
      cache: ["last-cache\n", 0o640],
    });
  });

  it("cancels before output promotion without changing output or status", async () => {
    const root = await createCatalogRoot();
    const paths = persistentPaths(root);
    await Promise.all([
      writeFile(paths.output, "last-output\n", { mode: 0o600 }),
      writeFile(paths.status, "last-status\n", { mode: 0o600 }),
    ]);
    const codexBinary = await createFakeCodex(root);
    const controller = new AbortController();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operation = refreshCatalogWithRuntime(
      {
        codexHome: root,
        codexBinary,
        output: paths.output,
        status: paths.status,
        cache: paths.cache,
        signal: controller.signal,
      },
      runtimeWith({
        beforeOutputPromote: async () => {
          reached.resolve();
          await release.promise;
        },
      }),
    );

    await reached.promise;
    controller.abort();
    release.resolve();
    await expect(operation).rejects.toMatchObject({ code: "cancelled" });
    expect(await readFile(paths.output, "utf8")).toBe("last-output\n");
    expect(await readFile(paths.status, "utf8")).toBe("last-status\n");
    expect(
      (await readdir(root)).some((name) => name.endsWith(".tmp")),
    ).toBeFalse();
  });

  it("completes status consistently when cancellation follows output commit", async () => {
    const root = await createCatalogRoot();
    const paths = persistentPaths(root);
    await writeFile(paths.status, "last-status\n", { mode: 0o600 });
    const codexBinary = await createFakeCodex(root);
    const controller = new AbortController();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operation = refreshCatalogWithRuntime(
      {
        codexHome: root,
        codexBinary,
        output: paths.output,
        status: paths.status,
        cache: paths.cache,
        signal: controller.signal,
      },
      runtimeWith({
        afterOutputCommit: async () => {
          reached.resolve();
          await release.promise;
        },
      }),
    );

    await reached.promise;
    controller.abort();
    release.resolve();
    const result = await operation;
    const statusDocument: unknown = JSON.parse(
      await readFile(paths.status, "utf8"),
    );
    expect(JSON.parse(await readFile(paths.output, "utf8"))).toEqual(
      source("v2"),
    );
    expect(statusDocument).toMatchObject({
      ok: true,
      output: paths.output,
      generation: result.generation,
      catalogChanged: result.catalogChanged,
    });
  });
});

function persistentPaths(root: string): {
  readonly output: string;
  readonly status: string;
  readonly cache: string;
} {
  return {
    output: join(root, "catalog.json"),
    status: join(root, "status.json"),
    cache: join(root, "cache.json"),
  };
}

function runtimeWith(
  commitHooks: CatalogRefreshCommitHooks,
): CatalogRefreshRuntime {
  return { codex: systemCodexRuntime, commitHooks };
}

async function persistentSnapshot(paths: {
  readonly output: string;
  readonly status: string;
  readonly cache: string;
}): Promise<Record<string, readonly [string, number]>> {
  const entries = await Promise.all(
    Object.entries(paths).map(async ([role, path]) => {
      const metadata = await stat(path);
      return [
        role,
        [await readFile(path, "utf8"), metadata.mode & 0o777],
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}
