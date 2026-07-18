// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  applyLunaV2Overlay,
  refreshCatalog,
  renderLaunchAgent,
} from "../src/index.ts";

const UNRESOLVED_PLACEHOLDER = /__[A-Z0-9_]+__/;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function model(
  slug: string,
  version: "v1" | "v2" = "v2",
): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "Representative Codex model",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "test instructions",
    model_messages: null,
    include_skills_usage_instructions: false,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272_000,
    max_context_window: 1_000_000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: false,
    multi_agent_version: slug === "gpt-5.6-luna" ? version : "v2",
  };
}

function source(version: "v1" | "v2" = "v1"): {
  models: Record<string, unknown>[];
} {
  return {
    models: [
      model("gpt-5.6-sol"),
      model("gpt-5.6-terra"),
      model("gpt-5.6-luna", version),
    ],
  };
}

function root(): string {
  const path = join(
    realpathSync(process.env["TMPDIR"] ?? "/tmp"),
    `skizzles-model-catalog-${crypto.randomUUID()}`,
  );
  roots.push(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

async function fakeCodex(
  path: string,
  bundled = source(),
  behavior:
    | "descendant"
    | "descendant-hang"
    | "hang"
    | "noisy"
    | "normal"
    | "probe" = "normal",
  version = "0.145.0-alpha.18",
): Promise<string> {
  const codex = join(path, "codex");
  const script = `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (${JSON.stringify(behavior)}.startsWith("descendant")) {
  const marker = ${JSON.stringify(join(path, "descendant-pids"))};
  const markerFile = Bun.file(marker);
  const previous = await markerFile.exists() ? await markerFile.text() : "";
  const descendant = Bun.spawn([
    "/bin/sh",
    "-c",
    "trap '' TERM; while :; do sleep 1; done",
  ], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  await Bun.write(marker, previous + descendant.pid + "\\n");
}
if (${JSON.stringify(behavior)} === "probe") {
  const home = process.env.HOME;
  const observationPath = ${JSON.stringify(join(path, "child-observations.ndjson"))};
  const observationFile = Bun.file(observationPath);
  const previous = await observationFile.exists() ? await observationFile.text() : "";
  const observation = {
    home,
    codexHome: process.env.CODEX_HOME,
    tmpdir: process.env.TMPDIR,
    sentinel: process.env.SKIZZLES_CHILD_SENTINEL ?? null,
    ambientHome: home === ${JSON.stringify(path)},
    realHome: home === ${JSON.stringify(process.env["HOME"] ?? null)},
    authPresent: await Bun.file(home + "/auth.json").exists(),
    environmentKeys: Object.keys(process.env).sort(),
  };
  await Bun.write(observationPath, previous + JSON.stringify(observation) + "\\n");
  if (observation.sentinel || observation.ambientHome || observation.authPresent || home !== process.env.CODEX_HOME) {
    console.error("raw-child-secret");
    process.exit(97);
  }
}
if (args.includes("--version")) { console.log(${JSON.stringify(
    `codex-cli ${version}`,
  )}); process.exit(0); }
if (${JSON.stringify(behavior)}.endsWith("hang")) {
  await Bun.write(${JSON.stringify(join(path, "failed-child-home"))}, process.env.HOME);
  await Bun.sleep(10_000);
  process.exit(0);
}
if (${JSON.stringify(
    behavior,
  )} === "noisy") { await Bun.stdout.write("x".repeat(16_384)); process.exit(0); }
const bundled = ${JSON.stringify(bundled)};
if (args.includes("--bundled")) { console.log(JSON.stringify(bundled)); process.exit(0); }
const config = args[args.indexOf("-c") + 1];
const candidatePath = JSON.parse(config.slice("model_catalog_json=".length));
const candidate = JSON.parse(await Bun.file(candidatePath).text());
if (process.env.HOME !== process.env.CODEX_HOME) {
  console.error("preflight HOME was not isolated");
  process.exit(1);
}
if (!candidate.models.every((entry) => typeof entry.display_name === "string")) {
  console.error("missing field display_name");
  process.exit(1);
}
console.log(JSON.stringify(candidate));
process.exit(0);
`;
  await Bun.write(codex, script);
  chmodSync(codex, 0o700);
  return codex;
}

function cache(
  models: unknown,
  fetchedAt = new Date(),
  version = "0.145.0-alpha.18",
): string {
  return JSON.stringify({
    fetched_at: fetchedAt.toISOString(),
    client_version: version,
    models,
  });
}

describe("Luna V2 model catalog overlay", () => {
  test("changes only Luna compatibility and becomes a no-op after upstream support", () => {
    const input = source();
    const overlaid = applyLunaV2Overlay(input);
    expect(overlaid).toEqual({ catalog: source("v2"), overlay: "applied" });
    expect(input).toEqual(source());
    expect(applyLunaV2Overlay(source("v2")).overlay).toBe("upstream-v2");
  });

  test("fails closed for incomplete, duplicate, or unexpected Luna metadata", () => {
    expect(() =>
      applyLunaV2Overlay({ models: [model("gpt-5.6-luna", "v1")] }),
    ).toThrow("incomplete");
    expect(() =>
      applyLunaV2Overlay({
        models: [...source().models, model("gpt-5.6-luna", "v1")],
      }),
    ).toThrow("found 2");
    const invalid = source();
    const invalidLuna = invalid.models[2];
    if (invalidLuna === undefined) {
      throw new Error("missing Luna fixture");
    }
    invalidLuna["multi_agent_version"] = null;
    expect(() => applyLunaV2Overlay(invalid)).toThrow("unexpected");
  });

  test("uses a fresh version-matched complete cache and repairs status and permissions", async () => {
    const path = root();
    const codex = await fakeCodex(path);
    await Bun.write(join(path, "models_cache.json"), cache(source().models));
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
    for (const [name, contents] of [
      ["stale", cache(source().models, new Date(Date.now() - 301_000))],
      ["mismatch", cache(source().models, new Date(), "0.144.0")],
      ["partial", cache([model("gpt-5.6-luna", "v1")])],
      ["future", cache(source().models, new Date(Date.now() + 1_000))],
    ] as const) {
      const path = root();
      const codex = await fakeCodex(path);
      await Bun.write(join(path, "models_cache.json"), contents);
      expect(
        await refreshCatalog({ codexHome: path, codexBinary: codex }),
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
      const path = root();
      const codex = await fakeCodex(path, source(), "normal", binaryVersion);
      await Bun.write(
        join(path, "models_cache.json"),
        cache(source().models, new Date(), cacheVersion),
      );
      expect(
        await refreshCatalog({ codexHome: path, codexBinary: codex }),
      ).toMatchObject({ source: expectedSource });
    }

    const path = root();
    const invalid = await fakeCodex(path, source(), "normal", "01.145.0");
    await expect(
      refreshCatalog({ codexHome: path, codexBinary: invalid }),
    ).rejects.toThrow("valid full semantic version");
  });

  test("isolates and removes every Codex child home without ambient credentials", async () => {
    const path = root();
    writeFileSync(join(path, "auth.json"), "ambient-credential", {
      mode: 0o600,
    });
    const codex = await fakeCodex(path, source(), "probe");
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
    for (const observation of observations) {
      expect(observation).toMatchObject({
        sentinel: null,
        ambientHome: false,
        realHome: false,
        authPresent: false,
      });
      expect(observation.home).toBe(observation.codexHome);
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
  });

  test("falls back without replacing last-good output when cache schema preflight fails", async () => {
    const path = root();
    const bundled = source();
    const codex = await fakeCodex(path, bundled);
    const malformed = source();
    const malformedModel = malformed.models[0];
    if (malformedModel === undefined) {
      throw new Error("missing model fixture");
    }
    delete malformedModel["display_name"];
    await Bun.write(join(path, "models_cache.json"), cache(malformed.models));
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
    const path = root();
    const output = join(path, "skizzles/model-catalog.json");
    mkdirSync(join(path, "skizzles"), { recursive: true, mode: 0o700 });
    chmodSync(join(path, "skizzles"), 0o700);
    writeFileSync(output, "last-good\n", { mode: 0o600 });
    const codex = await fakeCodex(path, {
      models: [model("gpt-5.6-luna", "v1")],
    });
    await expect(
      refreshCatalog({ codexHome: path, codexBinary: codex }),
    ).rejects.toThrow("incomplete");
    expect(readFileSync(output, "utf8")).toBe("last-good\n");
  });

  test("rejects path aliasing and symlink output without changing its target", async () => {
    const path = root();
    const codex = await fakeCodex(path);
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
    const path = root();
    const outside = root();
    const codex = await fakeCodex(path);
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
      const path = root();
      const codex = await fakeCodex(path);
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
      const path = root();
      const codex = await fakeCodex(path, source(), behavior);
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

  test("bounds and reaps descendant-held pipes on success and timeout", async () => {
    for (const behavior of ["descendant", "descendant-hang"] as const) {
      const path = root();
      const codex = await fakeCodex(path, source(), behavior);
      const started = Date.now();
      const operation = refreshCatalog({
        codexHome: path,
        codexBinary: codex,
        commandTimeoutMs: behavior === "descendant" ? 1_000 : 300,
      });
      if (behavior === "descendant") {
        await operation;
      } else {
        await expect(operation).rejects.toThrow("timed out");
      }
      expect(Date.now() - started).toBeLessThan(1_500);
      const pids = readFileSync(join(path, "descendant-pids"), "utf8")
        .trim()
        .split("\n")
        .map(Number);
      expect(pids.length).toBe(behavior === "descendant" ? 3 : 2);
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      if (behavior === "descendant-hang") {
        const failedHome = readFileSync(
          join(path, "failed-child-home"),
          "utf8",
        );
        expect(() => statSync(failedHome)).toThrow();
      }
    }
  });

  test("renders a launch agent with absolute escaped paths", () => {
    const template =
      "<array><string>__BUN_ABSOLUTE_PATH__</string><string>__SCRIPT_ABSOLUTE_PATH__</string><string>__CODEX_HOME_ABSOLUTE_PATH__</string><string>__CODEX_BINARY_ABSOLUTE_PATH__</string><string>__MODELS_CACHE_ABSOLUTE_PATH__</string></array>";
    const rendered = renderLaunchAgent(template, {
      bun: "/opt/bun&friends/bun",
      script: "/opt/skizzles/model-catalog.ts",
      codexHome: "/tmp/codex-home",
      codexBinary: "/Applications/ChatGPT.app/Contents/Resources/codex",
    });
    expect(rendered).toContain("/opt/bun&amp;friends/bun");
    expect(rendered).toContain("/tmp/codex-home/models_cache.json");
    expect(rendered).not.toMatch(UNRESOLVED_PLACEHOLDER);
    expect(() =>
      renderLaunchAgent(template, {
        bun: "relative/bun",
        script: "/opt/skizzles/model-catalog.ts",
        codexHome: "/tmp/codex-home",
        codexBinary: "/Applications/ChatGPT.app/Contents/Resources/codex",
      }),
    ).toThrow("must be absolute");
  });
});
