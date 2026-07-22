import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { refreshCatalog } from "../../src/index.ts";
import {
  awaitFakeChildReadiness,
  cleanupCatalogRoots,
  createCatalogRoot,
  createFakeCodex,
  fakeChildRecords,
  model,
  serializeCache,
  source,
} from "./harness.ts";

const DESCENDANT_TURNOVER_STRESS_TIMEOUT_MS = 30_000;

afterEach(cleanupCatalogRoots);

describe("model catalog refresh", () => {
  test("uses a fresh version-matched complete cache and repairs status and permissions", async () => {
    const path = await createCatalogRoot();
    const codex = await createFakeCodex(path);
    await Bun.write(
      join(path, "models_cache.json"),
      serializeCache(source().models),
    );
    const first = await refreshCatalog({ codexHome: path, codexBinary: codex });
    const outputPath = join(path, "skizzles/model-catalog.json");
    chmodSync(outputPath, 0o644);
    rmSync(join(path, "skizzles/model-catalog-status.json"));
    const second = await refreshCatalog({
      codexHome: path,
      codexBinary: codex,
    });
    expect(first).toMatchObject({
      source: "cache",
      updated: true,
      catalogChanged: true,
      lunaOverlay: "applied",
    });
    expect(second).toMatchObject({
      source: "cache",
      updated: false,
      catalogChanged: false,
    });
    expect(second.generation).toBe(first.generation);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "models_cache.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "skizzles")).mode & 0o777).toBe(0o700);
    expect(
      statSync(join(path, "skizzles/model-catalog-status.json")).mode & 0o777,
    ).toBe(0o600);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(source("v2"));
    expect(
      JSON.parse(
        readFileSync(join(path, "skizzles/model-catalog-status.json"), "utf8"),
      ),
    ).toMatchObject({ catalogChanged: false, generation: first.generation });
  });

  test("rejects stale, version-mismatched, and partial caches in favor of bundled models", async () => {
    const now = new Date("2040-01-02T03:04:05.000Z");
    for (const [name, contents] of [
      [
        "stale",
        serializeCache(source().models, new Date(now.getTime() - 301_000)),
      ],
      ["mismatch", serializeCache(source().models, now, "0.144.0")],
      ["partial", serializeCache([model("gpt-5.6-luna", "v1")], now)],
      [
        "future",
        serializeCache(source().models, new Date(now.getTime() + 1_000)),
      ],
    ] as const) {
      const path = await createCatalogRoot();
      const codex = await createFakeCodex(path);
      await Bun.write(join(path, "models_cache.json"), contents);
      expect(
        await refreshCatalog({ codexHome: path, codexBinary: codex, now }),
      ).toMatchObject({ source: "bundled" });
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("uses the complete SemVer including prerelease and build metadata for cache identity", async () => {
    for (const [binaryVersion, cacheVersion, expectedSource] of [
      ["0.145.0-alpha.18+build.7", "0.145.0-alpha.18+build.7", "cache"],
      ["0.145.0-alpha.18+build.7", "0.145.0-alpha.18", "bundled"],
      ["0.145.0-alpha.18", "0.145.0-alpha.19", "bundled"],
    ] as const) {
      const path = await createCatalogRoot();
      const codex = await createFakeCodex(
        path,
        source(),
        "normal",
        binaryVersion,
      );
      await Bun.write(
        join(path, "models_cache.json"),
        serializeCache(source().models, new Date(), cacheVersion),
      );
      expect(
        await refreshCatalog({ codexHome: path, codexBinary: codex }),
      ).toMatchObject({ source: expectedSource });
    }

    const path = await createCatalogRoot();
    const invalid = await createFakeCodex(path, source(), "normal", "01.145.0");
    await expect(
      refreshCatalog({ codexHome: path, codexBinary: invalid }),
    ).rejects.toThrow("valid full semantic version");
  });

  test("isolates and removes every Codex child home without ambient credentials", async () => {
    const path = await createCatalogRoot();
    writeFileSync(join(path, "auth.json"), "ambient-credential", {
      mode: 0o600,
    });
    const codex = await createFakeCodex(path, source(), "probe");
    const previous = process.env["SKIZZLES_CHILD_SENTINEL"];
    process.env["SKIZZLES_CHILD_SENTINEL"] = "raw-child-secret";
    try {
      await refreshCatalog({ codexHome: path, codexBinary: codex });
    } finally {
      if (previous === undefined) {
        delete process.env["SKIZZLES_CHILD_SENTINEL"];
      } else {
        process.env["SKIZZLES_CHILD_SENTINEL"] = previous;
      }
    }
    const observations = readFileSync(
      join(path, "child-observations.ndjson"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations).toHaveLength(3);
    expect(new Set(observations.map((entry) => entry.home)).size).toBe(3);
    expect(new Set(observations.map((entry) => entry.runRoot)).size).toBe(1);
    expect(new Set(observations.map((entry) => entry.runId)).size).toBe(1);
    const runRoot = observations[0]?.runRoot;
    if (typeof runRoot !== "string") {
      throw new Error("missing observed run root");
    }
    for (const observation of observations) {
      expect(observation).toMatchObject({
        sentinel: null,
        ambientHome: false,
        realHome: false,
        authPresent: false,
        ipcAvailable: false,
        markerRoot: runRoot,
        markerState: "open",
      });
      expect(observation.runRoot).toBe(runRoot);
      expect(observation.home).toBe(observation.codexHome);
      expect(observation.home).toStartWith(`${runRoot}/`);
      expect(observation.tmpdir).toStartWith(`${observation.home}/`);
      expect(observation.environmentKeys).toEqual([
        "CODEX_HOME",
        "HOME",
        "LANG",
        "LC_ALL",
        "NO_COLOR",
        "PATH",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
      ]);
      expect(() => statSync(observation.home)).toThrow();
    }
    for (const persistent of [
      join(path, "skizzles/model-catalog.json"),
      join(path, "skizzles/model-catalog-status.json"),
    ]) {
      expect(persistent.startsWith(`${runRoot}/`)).toBeFalse();
      expect(() => statSync(persistent)).not.toThrow();
    }
    expect(
      join(path, "models_cache.json").startsWith(`${runRoot}/`),
    ).toBeFalse();
    expect(() => statSync(runRoot)).toThrow();
  });

  test("falls back without replacing last-good output when cache schema preflight fails", async () => {
    const path = await createCatalogRoot();
    const bundled = source();
    const codex = await createFakeCodex(path, bundled);
    const malformed = source();
    const malformedModel = malformed.models[0];
    if (malformedModel === undefined) {
      throw new Error("missing model fixture");
    }
    delete malformedModel["display_name"];
    await Bun.write(
      join(path, "models_cache.json"),
      serializeCache(malformed.models),
    );
    const result = await refreshCatalog({
      codexHome: path,
      codexBinary: codex,
    });
    expect(result.source).toBe("bundled");
    expect(JSON.parse(readFileSync(result.output, "utf8"))).toEqual(
      source("v2"),
    );
  });

  test("preserves last-good output when bundled catalog validation fails", async () => {
    const path = await createCatalogRoot();
    const output = join(path, "skizzles/model-catalog.json");
    mkdirSync(join(path, "skizzles"), { recursive: true, mode: 0o700 });
    chmodSync(join(path, "skizzles"), 0o700);
    writeFileSync(output, "last-good\n", { mode: 0o600 });
    const codex = await createFakeCodex(path, {
      models: [model("gpt-5.6-luna", "v1")],
    });
    await expect(
      refreshCatalog({ codexHome: path, codexBinary: codex }),
    ).rejects.toThrow("incomplete");
    expect(readFileSync(output, "utf8")).toBe("last-good\n");
  });

  test("rejects path aliasing and symlink output without changing its target", async () => {
    const path = await createCatalogRoot();
    const codex = await createFakeCodex(path);
    const shared = join(path, "shared.json");
    await expect(
      refreshCatalog({
        codexHome: path,
        codexBinary: codex,
        output: shared,
        status: shared,
      }),
    ).rejects.toThrow("must be distinct");

    const victim = join(path, "victim.json");
    const output = join(path, "catalog-link.json");
    writeFileSync(victim, "victim\n");
    symlinkSync(victim, output);
    await expect(
      refreshCatalog({ codexHome: path, codexBinary: codex, output }),
    ).rejects.toThrow("symlink");
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
  });

  test("rejects physical aliases and symlink ancestors without writing outside", async () => {
    const path = await createCatalogRoot();
    const outside = await createCatalogRoot();
    const codex = await createFakeCodex(path);
    const output = join(path, "catalog.json");
    const status = join(path, "status.json");
    writeFileSync(output, "last-good\n", { mode: 0o600 });
    linkSync(output, status);
    await expect(
      refreshCatalog({
        codexHome: path,
        codexBinary: codex,
        output,
        status,
      }),
    ).rejects.toThrow("exactly one hard link");
    expect(readFileSync(output, "utf8")).toBe("last-good\n");

    const alias = join(path, "outside-alias");
    symlinkSync(outside, alias);
    const escapedOutput = join(alias, "escaped.json");
    await expect(
      refreshCatalog({
        codexHome: path,
        codexBinary: codex,
        output: escapedOutput,
      }),
    ).rejects.toThrow("symlink path components");
    expect(() => readFileSync(join(outside, "escaped.json"))).toThrow();
  });

  test("rejects external hard links for every managed catalog path without mutating the victim", async () => {
    for (const role of ["output", "status", "cache"] as const) {
      const path = await createCatalogRoot();
      const codex = await createFakeCodex(path);
      const victim = join(path, `${role}-victim.json`);
      const managed = {
        output: join(path, "catalog.json"),
        status: join(path, "status.json"),
        cache: join(path, "cache.json"),
      };
      writeFileSync(victim, "external-victim\n", { mode: 0o640 });
      linkSync(victim, managed[role]);
      await expect(
        refreshCatalog({
          codexHome: path,
          codexBinary: codex,
          ...managed,
        }),
      ).rejects.toThrow("exactly one hard link");
      expect(readFileSync(victim, "utf8")).toBe("external-victim\n");
      expect(statSync(victim).mode & 0o777).toBe(0o640);
      expect(statSync(victim).nlink).toBe(2);
    }
  });

  test("terminates noisy and hanging Codex subprocesses", async () => {
    for (const behavior of ["noisy", "hang"] as const) {
      const path = await createCatalogRoot();
      const codex = await createFakeCodex(path, source(), behavior);
      const started = Date.now();
      await expect(
        refreshCatalog({
          codexHome: path,
          codexBinary: codex,
          commandTimeoutMs: behavior === "hang" ? 100 : 2_000,
          maxCatalogBytes: 1024,
        }),
      ).rejects.toThrow(behavior === "hang" ? "timed out" : "byte limit");
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });

  test("times out before fake command initialization without requiring descendant readiness", async () => {
    const path = await createCatalogRoot();
    const codex = await createFakeCodex(path, source(), "initialization-hang");
    const started = Date.now();
    await expect(
      refreshCatalog({
        codexHome: path,
        codexBinary: codex,
        commandTimeoutMs: 20,
      }),
    ).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fakeChildRecords(path)).toEqual([]);
  });

  test(
    "bounds and reaps descendant-held pipes on success and timeout",
    async () => {
      for (let iteration = 0; iteration < 3; iteration += 1) {
        for (const behavior of ["descendant", "descendant-hang"] as const) {
          const path = await createCatalogRoot();
          const codex = await createFakeCodex(path, source(), behavior);
          const started = Date.now();
          const operation = refreshCatalog({
            codexHome: path,
            codexBinary: codex,
            commandTimeoutMs: behavior === "descendant" ? 1_000 : 1_500,
          });
          if (behavior === "descendant") {
            await operation;
          } else {
            await awaitFakeChildReadiness(path, "bundled", 1_000);
            await expect(operation).rejects.toThrow("timed out");
          }
          expect(Date.now() - started).toBeLessThan(4_000);
          const records = fakeChildRecords(path);
          expect(records.length).toBe(behavior === "descendant" ? 3 : 2);
          expect(new Set(records.map((record) => record.runRoot)).size).toBe(1);
          const lifecycle = readFileSync(join(path, "child-lifecycle"), "utf8")
            .trim()
            .split("\n");
          expect(new Set(lifecycle)).toEqual(
            new Set(records.map((record) => record.token)),
          );
          for (const record of records) {
            expect(record.processGroup).not.toBe(record.codexPid);
            expect(() => process.kill(record.pid, 0)).toThrow();
            expect(() => statSync(record.runRoot)).toThrow();
          }
          if (behavior === "descendant-hang") {
            const failedHome = readFileSync(
              join(path, "failed-child-home"),
              "utf8",
            );
            expect(() => statSync(failedHome)).toThrow();
          }
        }
      }
    },
    DESCENDANT_TURNOVER_STRESS_TIMEOUT_MS,
  );

  test("closes the shared workspace and descendants on cancellation", async () => {
    const path = await createCatalogRoot();
    const codex = await createFakeCodex(path, source(), "descendant-hang");
    const controller = new AbortController();
    const operation = refreshCatalog({
      codexHome: path,
      codexBinary: codex,
      commandTimeoutMs: 5_000,
      signal: controller.signal,
    });
    await awaitFakeChildReadiness(path, "bundled", 1_000);
    controller.abort();
    await expect(operation).rejects.toThrow("codex command was cancelled");
    const records = fakeChildRecords(path);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(() => process.kill(record.pid, 0)).toThrow();
      expect(() => statSync(record.runRoot)).toThrow();
    }
  });

  test("reports workspace cleanup failure and leaves deterministic evidence", async () => {
    const path = await createCatalogRoot();
    const codex = await createFakeCodex(path, source(), "cleanup-failure");
    await expect(
      refreshCatalog({ codexHome: path, codexBinary: codex }),
    ).rejects.toThrow("codex command cleanup failed");
    const runRoot = readFileSync(join(path, "failed-run-root"), "utf8");
    try {
      expect(() => statSync(runRoot)).not.toThrow();
      expect(
        join(path, "skizzles/model-catalog.json").startsWith(`${runRoot}/`),
      ).toBeFalse();
      expect(() =>
        statSync(join(path, "skizzles/model-catalog.json")),
      ).not.toThrow();
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  test("fail-safe cleanup reaps registered fake descendants before removing fixtures", async () => {
    const path = await createCatalogRoot();
    const codex = await createFakeCodex(path, source(), "descendant");
    const invocation = Bun.spawn([codex, "--version"], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await invocation.exited).toBe(0);
    const record = await awaitFakeChildReadiness(path, "version", 1_000);
    expect(() => process.kill(record.pid, 0)).not.toThrow();

    await cleanupCatalogRoots();

    expect(() => process.kill(record.pid, 0)).toThrow();
    expect(() => statSync(path)).toThrow();
  });
});
