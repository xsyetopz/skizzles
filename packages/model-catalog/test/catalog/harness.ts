import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  create,
  type OwnedChild,
  type RunWorkspace,
} from "@skizzles/run-workspace";

const PRIVATE_DIRECTORY_MODE = 0o700;
const READINESS_POLL_MS = 10;
const fixtures: RunWorkspace[] = [];

export type FakeCodexCommand = "bundled" | "preflight" | "version";

export interface FakeChildRecord {
  codexPid: number;
  command: FakeCodexCommand;
  pid: number;
  processGroup: number;
  runRoot: string;
  token: string;
}

interface ProcessSnapshot {
  command: string;
  processGroup: number;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isFakeCodexCommand(value: unknown): value is FakeCodexCommand {
  return value === "bundled" || value === "preflight" || value === "version";
}

function parseFakeChildRecord(value: unknown): FakeChildRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const command = "command" in value ? value.command : undefined;
  const codexPid = "codexPid" in value ? value.codexPid : undefined;
  const pid = "pid" in value ? value.pid : undefined;
  const processGroup = "processGroup" in value ? value.processGroup : undefined;
  const runRoot = "runRoot" in value ? value.runRoot : undefined;
  const token = "token" in value ? value.token : undefined;
  if (
    !isFakeCodexCommand(command) ||
    !isPositiveSafeInteger(codexPid) ||
    !isPositiveSafeInteger(pid) ||
    !isPositiveSafeInteger(processGroup) ||
    typeof runRoot !== "string" ||
    typeof token !== "string" ||
    !/^skizzles-model-catalog-descendant-[0-9a-f-]{36}$/.test(token)
  ) {
    return undefined;
  }
  return { codexPid, command, pid, processGroup, runRoot, token };
}

export function fakeChildRecords(root: string): FakeChildRecord[] {
  let contents: string;
  try {
    contents = readFileSync(join(root, "descendant-pids"), "utf8");
  } catch {
    return [];
  }
  const records: FakeChildRecord[] = [];
  for (const line of contents.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      const record = parseFakeChildRecord(value);
      if (record !== undefined) {
        records.push(record);
      }
    } catch {
      // A malformed or partial record cannot safely identify a process.
    }
  }
  return records;
}

function processSnapshot(pid: number): ProcessSnapshot | undefined {
  const result = Bun.spawnSync(
    ["/bin/ps", "-o", "pgid=,command=", "-p", String(pid)],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const match = new TextDecoder()
    .decode(result.stdout)
    .match(/^\s*([1-9][0-9]*)\s+([\s\S]+)$/);
  if (match === null) {
    return undefined;
  }
  const processGroup = Number(match[1]);
  const command = match[2];
  if (!isPositiveSafeInteger(processGroup) || command === undefined) {
    return undefined;
  }
  return { command, processGroup };
}

function isRegisteredChild(record: FakeChildRecord): boolean {
  const snapshot = processSnapshot(record.pid);
  return (
    snapshot !== undefined &&
    snapshot.processGroup === record.processGroup &&
    snapshot.command.includes(record.token)
  );
}

function signalRegisteredGroup(
  record: FakeChildRecord,
  signal: NodeJS.Signals,
): void {
  if (!isRegisteredChild(record)) {
    return;
  }
  try {
    process.kill(-record.processGroup, signal);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ESRCH")
    ) {
      throw error;
    }
  }
}

async function waitForRegisteredChildExit(
  record: FakeChildRecord,
): Promise<void> {
  while (isRegisteredChild(record)) {
    await Bun.sleep(READINESS_POLL_MS);
  }
}

function registeredChild(record: FakeChildRecord): OwnedChild {
  return {
    label: `fake-codex-${record.command}-${record.pid}`,
    pid: record.pid,
    requestStop: () => signalRegisteredGroup(record, "SIGTERM"),
    forceStop: () => signalRegisteredGroup(record, "SIGKILL"),
    waitForExit: () => waitForRegisteredChildExit(record),
  };
}

export async function awaitFakeChildReadiness(
  root: string,
  command: FakeCodexCommand,
  timeoutMs: number,
): Promise<FakeChildRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = fakeChildRecords(root).find(
      (candidate) => candidate.command === command,
    );
    if (record !== undefined) {
      return record;
    }
    await Bun.sleep(
      Math.min(READINESS_POLL_MS, Math.max(1, deadline - Date.now())),
    );
  }
  throw new Error(`fake Codex ${command} command did not publish readiness`);
}

export async function cleanupCatalogRoots(): Promise<void> {
  const failures: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      for (const record of fakeChildRecords(fixture.path())) {
        fixture.registerChild(registeredChild(record));
      }
      const report = await fixture.close();
      if (report.state !== "deleted") {
        failures.push(
          new Error(`model catalog fixture cleanup failed: ${report.error}`),
        );
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "model catalog fixture cleanup failed");
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

export async function createCatalogRoot(): Promise<string> {
  const fixture = await create({ gracefulStopMs: 100, forceStopMs: 100 });
  fixtures.push(fixture);
  return fixture.path();
}

export async function createFakeCodex(
  path: string,
  bundled = source(),
  behavior:
    | "descendant"
    | "descendant-hang"
    | "cleanup-failure"
    | "hang"
    | "initialization-hang"
    | "noisy"
    | "normal"
    | "probe" = "normal",
  version = "0.145.0-alpha.18",
): Promise<string> {
  const codex = join(path, "codex");
  const descendantScript = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
let recorded = false;
process.on("SIGTERM", () => {
  if (recorded) return;
  recorded = true;
  const root = process.env.SKIZZLES_RUN_ROOT;
  const lifecycle = process.env.SKIZZLES_LIFECYCLE_PATH;
  const token = process.env.SKIZZLES_CHILD_TOKEN;
  if (root && lifecycle && token && existsSync(root)) {
    appendFileSync(lifecycle, token + "\\n");
  }
});
writeFileSync(process.env.SKIZZLES_CHILD_READY, "ready\\n");
await Bun.sleep(10_000);
`;
  const script = `#!/usr/bin/env bun
import { unlink } from "node:fs/promises";
import { dirname } from "node:path";
const args = Bun.argv.slice(2);
const isolatedRoot = dirname(process.env.HOME);
if (${JSON.stringify(behavior)} === "initialization-hang") {
  await Bun.sleep(10_000);
  process.exit(0);
}
if (${JSON.stringify(behavior)}.startsWith("descendant")) {
  const marker = ${JSON.stringify(join(path, "descendant-pids"))};
  const markerFile = Bun.file(marker);
  const previous = await markerFile.exists() ? await markerFile.text() : "";
  const command = args.includes("--version")
    ? "version"
    : args.includes("--bundled")
      ? "bundled"
      : "preflight";
  const token = "skizzles-model-catalog-descendant-" + crypto.randomUUID();
  const runRoot = dirname(process.env.HOME);
  const ready = ${JSON.stringify(path)} + "/child-ready-" + token;
  const descendant = Bun.spawn([
    process.execPath,
    "-e",
    ${JSON.stringify(descendantScript)},
    token,
  ], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      SKIZZLES_CHILD_TOKEN: token,
      SKIZZLES_CHILD_READY: ready,
      SKIZZLES_LIFECYCLE_PATH: ${JSON.stringify(join(path, "child-lifecycle"))},
      SKIZZLES_RUN_ROOT: runRoot,
    },
  });
  for (let attempt = 0; attempt < 100 && !(await Bun.file(ready).exists()); attempt += 1) {
    await Bun.sleep(10);
  }
  if (!(await Bun.file(ready).exists())) {
    throw new Error("fake descendant did not initialize");
  }
  const record = {
    codexPid: process.pid,
    command,
    pid: descendant.pid,
    processGroup: Number(new TextDecoder().decode(Bun.spawnSync(
      ["/bin/ps", "-o", "pgid=", "-p", String(process.pid)],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    ).stdout).trim()),
    runRoot,
    token,
  };
  await Bun.write(marker, previous + JSON.stringify(record) + "\\n");
}
if (${JSON.stringify(behavior)} === "probe") {
  const home = process.env.HOME;
  const runRoot = dirname(home);
  const marker = JSON.parse(await Bun.file(runRoot + "/.skizzles-run-workspace.json").text());
  const observationPath = ${JSON.stringify(join(path, "child-observations.ndjson"))};
  const observationFile = Bun.file(observationPath);
  const previous = await observationFile.exists() ? await observationFile.text() : "";
  const observation = {
    home,
    runRoot,
    runId: marker.runId,
    markerRoot: marker.root,
    markerState: marker.state,
    codexHome: process.env.CODEX_HOME,
    tmpdir: process.env.TMPDIR,
    sentinel: process.env.SKIZZLES_CHILD_SENTINEL ?? null,
    ambientHome: home === ${JSON.stringify(path)},
    realHome: home === ${
      // biome-ignore lint/complexity/useLiteralKeys: Node's ProcessEnv is an index-signature boundary under strict TypeScript.
      JSON.stringify(process.env["HOME"] ?? null)
    },
    authPresent: await Bun.file(home + "/auth.json").exists(),
    ipcAvailable: typeof process.send === "function",
    environmentKeys: Object.keys(process.env).sort(),
  };
  await Bun.write(observationPath, previous + JSON.stringify(observation) + "\\n");
  if (observation.sentinel || observation.ambientHome || observation.authPresent || observation.ipcAvailable || home !== process.env.CODEX_HOME) {
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
if (${JSON.stringify(behavior)} === "cleanup-failure") {
  await Bun.write(${JSON.stringify(join(path, "failed-run-root"))}, isolatedRoot);
  await unlink(isolatedRoot + "/.skizzles-run-workspace.json");
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
