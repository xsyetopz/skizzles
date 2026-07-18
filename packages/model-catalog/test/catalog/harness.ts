import { chmodSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const PRIVATE_DIRECTORY_MODE = 0o700;
const roots: string[] = [];

export function cleanupCatalogRoots(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export function model(
  slug: string,
  version: "v1" | "v2" = "v2",
): Record<string, unknown> {
  let multiAgentVersion: "v1" | "v2" = "v2";
  if (slug === "gpt-5.6-luna") {
    multiAgentVersion = version;
  }
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
    multi_agent_version: multiAgentVersion,
  };
}

export function source(version: "v1" | "v2" = "v1"): {
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

export function createCatalogRoot(): string {
  const path = join(
    // biome-ignore lint/complexity/useLiteralKeys: Node's ProcessEnv is an index-signature boundary under strict TypeScript.
    realpathSync(process.env["TMPDIR"] ?? "/tmp"),
    `skizzles-model-catalog-${crypto.randomUUID()}`,
  );
  roots.push(path);
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  return path;
}

export async function createFakeCodex(
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
    realHome: home === ${
      // biome-ignore lint/complexity/useLiteralKeys: Node's ProcessEnv is an index-signature boundary under strict TypeScript.
      JSON.stringify(process.env["HOME"] ?? null)
    },
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
  chmodSync(codex, PRIVATE_DIRECTORY_MODE);
  return codex;
}

export function serializeCache(
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
