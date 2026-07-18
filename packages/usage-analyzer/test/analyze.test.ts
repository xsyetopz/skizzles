// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { Database } from "bun:sqlite";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";

const analyzer = join(import.meta.dir, "../src/main.ts");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "skizzles-usage-analyzer-"));
  fixtures.push(home);
  return home;
}

function run(
  home: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = { ...process.env };
  Object.assign(env, extraEnv);
  if (!("CODEX_HOME" in extraEnv)) {
    env["CODEX_HOME"] = home;
  } else if (extraEnv["CODEX_HOME"] === undefined) {
    delete env["CODEX_HOME"];
  }
  return Bun.spawnSync({
    cmd: [process.execPath, analyzer, ...args],
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result: ReturnType<typeof Bun.spawnSync>) {
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const content = await readFile(full);
        files[relative(root, full)] = createHash("sha256")
          .update(content)
          .digest("hex");
      }
    }
  }
  await visit(root);
  return files;
}

const rootId = "11111111-1111-1111-1111-111111111111";
const childId = "22222222-2222-2222-2222-222222222222";
const guardianId = "33333333-3333-3333-3333-333333333333";
const timestamp = "2026-07-02T12:00:00.000Z";

async function writeJsonl(path: string, events: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

test("prints portable help without touching a Codex home", async () => {
  const home = await fixtureHome();
  const result = output(run(home, ["--help"]));

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: skizzles-analyze --from");
  expect(result.stdout).not.toContain("packages/usage-analyzer");
  expect(result.stdout).not.toContain("src/main.ts");
  expect(await snapshot(home)).toEqual({});
});

test("returns an empty report when sessions and state files are absent", async () => {
  const home = await fixtureHome();
  const before = await snapshot(home);
  const result = output(
    run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]),
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    range: { rolloutFiles: 0, bucket: "day" },
    actors: {},
    models: {},
    subagentRoutes: {},
    subagentRoles: {},
    subagentTiers: {},
    topRootTasks: [],
    timeline: {},
  });
  expect(await snapshot(home)).toEqual(before);
});

test("falls back to HOME/.codex without writing to it", async () => {
  const home = await fixtureHome();
  const codexHome = join(home, ".codex");
  await writeJsonl(
    join(codexHome, "sessions", "2026", "07", "02", `${rootId}.jsonl`),
    [
      {
        timestamp,
        type: "session_meta",
        payload: { id: rootId, source: "cli" },
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 3,
              output_tokens: 1,
              total_tokens: 4,
            },
          },
        },
      },
    ],
  );
  const before = await snapshot(home);

  const result = output(
    run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"], {
      CODEX_HOME: undefined,
      HOME: home,
    }),
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).actors.root).toMatchObject({
    inputTokens: 3,
    outputTokens: 1,
  });
  expect(await snapshot(home)).toEqual(before);
});

test("aggregates synthetic active and archived rollouts, reads titles, and leaves inputs unchanged", async () => {
  const home = await fixtureHome();
  const sessions = join(home, "sessions", "2026", "07", "02");
  const archived = join(home, "archived_sessions", "2026", "07", "02");
  await writeJsonl(join(sessions, `${rootId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: rootId, source: "cli" } },
    {
      timestamp,
      type: "turn_context",
      payload: { model: "gpt-fixture", effort: "medium" },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
        },
        rate_limits: {
          primary: { used_percent: 12.5, resets_at: 1_783_050_000 },
        },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
        },
      },
    },
  ]);
  await writeJsonl(join(archived, `${rootId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: rootId, source: "cli" } },
  ]);
  await writeJsonl(join(archived, `${childId}.jsonl`), [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: childId,
        forked_from_id: rootId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: rootId,
              agent_path: "/root/worker__fixture",
            },
          },
        },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 999,
            cached_input_tokens: 0,
            output_tokens: 999,
            total_tokens: 1998,
          },
          total_token_usage: {
            input_tokens: 999,
            cached_input_tokens: 0,
            output_tokens: 999,
            total_tokens: 1998,
          },
        },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "inherited-turn" },
    },
    {
      timestamp,
      type: "turn_context",
      payload: {
        turn_id: "inherited-turn",
        model: "gpt-parent",
        effort: "high",
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 999,
            cached_input_tokens: 0,
            output_tokens: 999,
            total_tokens: 1998,
          },
          total_token_usage: {
            input_tokens: 1998,
            cached_input_tokens: 0,
            output_tokens: 1998,
            total_tokens: 3996,
          },
        },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "child-turn" },
    },
    {
      timestamp,
      type: "turn_context",
      payload: {
        turn_id: "child-turn",
        model: "gpt-fixture",
        effort: "medium",
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 2048,
            cached_input_tokens: 5,
            output_tokens: 2008,
            total_tokens: 4056,
          },
        },
      },
    },
  ]);
  await writeJsonl(join(archived, `${guardianId}.jsonl`), [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: guardianId,
        source: {
          subagent: {
            other: "guardian",
            thread_spawn: { parent_thread_id: rootId },
          },
        },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_complete",
        duration_ms: 500,
        last_agent_message: '{"outcome":"allow"}',
      },
    },
  ]);
  const db = new Database(join(home, "state_42.sqlite"));
  db.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT); INSERT INTO threads VALUES ('11111111-1111-1111-1111-111111111111', 'Synthetic root');",
  );
  db.close();
  const before = await snapshot(home);

  const result = output(
    run(home, [
      "--from",
      "2026-07-01",
      "--to",
      "2026-07-02",
      "--bucket",
      "hour",
      "--cached-weight",
      "0.5",
      "--top",
      "1",
      "--json",
    ]),
  );

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.range).toMatchObject({
    rolloutFiles: 3,
    bucket: "hour",
    cachedWeight: 0.5,
  });
  expect(report.actors.root).toMatchObject({
    sessions: 1,
    inferences: 1,
    inputTokens: 100,
    cachedInputTokens: 40,
    comparisonProxy: 100,
  });
  expect(report.actors.subagent).toMatchObject({
    sessions: 1,
    inferences: 1,
    inputTokens: 50,
    cachedInputTokens: 5,
    comparisonProxy: 57.5,
  });
  expect(report.models["gpt-fixture"]).toMatchObject({
    sessions: 2,
    inferences: 2,
    inputTokens: 150,
  });
  expect(report.subagentRoutes["gpt-fixture/medium"]).toMatchObject({
    sessions: 1,
    inferences: 1,
  });
  expect(report.subagentRoles.worker).toMatchObject({
    sessions: 1,
    inferences: 1,
  });
  expect(report.subagentTiers).toEqual({});
  expect(report.guardian).toMatchObject({
    reviews: 1,
    allow: 1,
    deny: 0,
    durationMs: 500,
  });
  expect(report.rateLimit).toMatchObject({
    firstUsedPercent: 12.5,
    lastUsedPercent: 12.5,
  });
  expect(report.topRootTasks).toHaveLength(1);
  expect(report.topRootTasks[0]).toMatchObject({
    id: rootId,
    title: "Synthetic root",
    comparisonProxy: 157.5,
  });
  expect(Object.values(report.timeline)).toHaveLength(1);
  expect(await snapshot(home)).toEqual(before);
});

test("preserves role and legacy tier attribution for historical task names", async () => {
  const home = await fixtureHome();
  const archived = join(home, "archived_sessions", "2026", "07", "02");
  await writeJsonl(join(archived, `${childId}.jsonl`), [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: childId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: rootId,
              agent_path: "/root/scoped__worker__fixture",
            },
          },
        },
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: { model: "gpt-fixture", effort: "high" },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 2,
            total_tokens: 12,
          },
        },
      },
    },
  ]);

  const result = output(
    run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]),
  );

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.subagentRoutes["gpt-fixture/high"]).toMatchObject({
    sessions: 1,
    inferences: 1,
  });
  expect(report.subagentRoles.worker).toMatchObject({
    sessions: 1,
    inferences: 1,
  });
  expect(report.subagentTiers.scoped).toMatchObject({
    sessions: 1,
    inferences: 1,
  });
});

test("ignores malformed JSONL while preserving valid usage", async () => {
  const home = await fixtureHome();
  const path = join(home, "sessions", "2026", "07", "02", `${rootId}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    [
      "{not-json}",
      JSON.stringify({
        timestamp,
        type: "session_meta",
        payload: { id: rootId, source: "cli" },
      }),
      JSON.stringify({
        timestamp,
        type: "turn_context",
        payload: { model: "fixture" },
      }),
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 7,
              output_tokens: 3,
              total_tokens: 10,
            },
          },
        },
      }),
      "also malformed",
    ].join("\n"),
  );

  const result = output(
    run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).actors.root).toMatchObject({
    sessions: 1,
    inferences: 1,
    inputTokens: 7,
    outputTokens: 3,
  });
});

test("selects the largest active or archived duplicate and reports one rollout", async () => {
  const home = await fixtureHome();
  const active = join(home, "sessions", "2026", "07", "02", `${rootId}.jsonl`);
  const archived = join(
    home,
    "archived_sessions",
    "2026",
    "07",
    "02",
    `${rootId}.jsonl`,
  );
  await writeJsonl(active, [
    { timestamp, type: "session_meta", payload: { id: rootId, source: "cli" } },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        },
      },
    },
  ]);
  await writeJsonl(archived, [
    { timestamp, type: "session_meta", payload: { id: rootId, source: "cli" } },
    { timestamp, type: "turn_context", payload: { model: "fixture" } },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 20,
            output_tokens: 5,
            total_tokens: 25,
          },
        },
      },
    },
    {
      timestamp,
      type: "response_item",
      payload: { text: "padding makes this duplicate larger" },
    },
  ]);

  const result = output(
    run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]),
  );
  const report = JSON.parse(result.stdout);
  expect(result.exitCode).toBe(0);
  expect(report.range.rolloutFiles).toBe(1);
  expect(report.actors.root).toMatchObject({
    inputTokens: 20,
    outputTokens: 5,
  });
});

test("excludes inherited fork usage before the child task starts", async () => {
  const home = await fixtureHome();
  const path = join(
    home,
    "archived_sessions",
    "2026",
    "07",
    "02",
    `${childId}.jsonl`,
  );
  await writeJsonl(path, [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: childId,
        forked_from_id: rootId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: rootId,
              agent_path: "/root/worker__child",
            },
          },
        },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 100,
            total_tokens: 200,
          },
        },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "own" },
    },
    {
      timestamp,
      type: "turn_context",
      payload: { turn_id: "own", model: "fixture" },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 110,
            output_tokens: 105,
            total_tokens: 215,
          },
        },
      },
    },
  ]);

  const report = JSON.parse(
    output(run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]))
      .stdout,
  );
  expect(report.actors.subagent).toMatchObject({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

test("human output includes report headings and proxy explanation", async () => {
  const home = await fixtureHome();
  await writeJsonl(
    join(home, "sessions", "2026", "07", "02", `${rootId}.jsonl`),
    [
      {
        timestamp,
        type: "session_meta",
        payload: { id: rootId, source: "cli" },
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 4,
              output_tokens: 2,
              total_tokens: 6,
            },
          },
        },
      },
    ],
  );
  const result = output(
    run(home, ["--from", "2026-07-01", "--to", "2026-07-02"]),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Actors");
  expect(result.stdout).toContain("Models");
  expect(result.stdout).toContain("Guardian");
  expect(result.stdout).toContain("Timeline");
  expect(result.stdout).toContain("Proxy = uncached input");
});

test("uses local time for date ranges and hourly bucket labels", async () => {
  const home = await fixtureHome();
  await writeJsonl(
    join(home, "sessions", "2026", "07", "02", `${rootId}.jsonl`),
    [
      {
        timestamp: "2026-07-02T02:00:00.000Z",
        type: "session_meta",
        payload: { id: rootId, source: "cli" },
      },
      {
        timestamp: "2026-07-02T02:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 3,
              output_tokens: 1,
              total_tokens: 4,
            },
          },
        },
      },
    ],
  );

  const result = output(
    run(
      home,
      [
        "--from",
        "2026-07-01",
        "--to",
        "2026-07-01",
        "--bucket",
        "hour",
        "--json",
      ],
      { TZ: "Pacific/Honolulu" },
    ),
  );

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.range.timezone).toBe("Pacific/Honolulu");
  expect(Object.keys(report.timeline)).toEqual(["2026-07-01 16:00"]);
});

test("rejects invalid CLI input with a diagnostic and nonzero exit", async () => {
  const home = await fixtureHome();
  const result = output(run(home, ["--bucket", "minute"]));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--bucket must be hour or day");
});
