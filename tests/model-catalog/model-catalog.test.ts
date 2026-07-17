import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  applyLunaV2Overlay,
  refreshCatalog,
  renderLaunchAgent,
} from "../../runtime/model-catalog";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  }),
);

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
  models: Array<Record<string, unknown>>;
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
    process.env["TMPDIR"] ?? "/tmp",
    `skizzles-model-catalog-${crypto.randomUUID()}`,
  );
  roots.push(path);
  mkdirSync(path, { recursive: true });
  return path;
}

async function fakeCodex(
  path: string,
  bundled = source(),
  behavior: "normal" | "hang" | "noisy" = "normal",
): Promise<string> {
  const codex = join(path, "codex");
  const script = `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.145.0-alpha.18"); process.exit(0); }
if (${JSON.stringify(
    behavior,
  )} === "hang") { await Bun.sleep(10_000); process.exit(0); }
if (${JSON.stringify(
    behavior,
  )} === "noisy") { await Bun.stdout.write("x".repeat(16_384)); process.exit(0); }
const bundled = ${JSON.stringify(bundled)};
if (args.includes("--bundled")) { console.log(JSON.stringify(bundled)); process.exit(0); }
const config = args[args.indexOf("-c") + 1];
const candidatePath = JSON.parse(config.slice("model_catalog_json=".length));
const candidate = JSON.parse(await Bun.file(candidatePath).text());
if (!candidate.models.every((entry) => typeof entry.display_name === "string")) {
  console.error("missing field display_name");
  process.exit(1);
}
console.log(JSON.stringify(candidate));
`;
  await Bun.write(codex, script);
  chmodSync(codex, 0o700);
  return codex;
}

function cache(
  models: unknown,
  fetchedAt = new Date(),
  version = "0.145.0",
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
    invalid.models[2]!["multi_agent_version"] = null;
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

  test("falls back without replacing last-good output when cache schema preflight fails", async () => {
    const path = root();
    const bundled = source();
    const codex = await fakeCodex(path, bundled);
    const malformed = source();
    delete malformed.models[0]!["display_name"];
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
    expect(rendered).not.toMatch(/__[A-Z0-9_]+__/);
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
