// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { Database } from "bun:sqlite";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import {
  childId,
  commandOutput,
  createFixtureHomeFactory,
  guardianId,
  rootId,
  runAnalyzer,
  snapshot,
  timestamp,
  writeJsonl,
} from "./harness.ts";

const { cleanupFixtureHomes, fixtureHome } = createFixtureHomeFactory();

afterEach(cleanupFixtureHomes);

it("returns an empty report when sessions and state files are absent", async () => {
  const home = await fixtureHome();
  const before = await snapshot(home);
  const result = commandOutput(
    runAnalyzer(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]),
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

it("falls back to HOME/.codex without writing to it", async () => {
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

  const result = commandOutput(
    runAnalyzer(
      home,
      ["--from", "2026-07-01", "--to", "2026-07-02", "--json"],
      {
        CODEX_HOME: undefined,
        HOME: home,
      },
    ),
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).actors.root).toMatchObject({
    inputTokens: 3,
    outputTokens: 1,
  });
  expect(await snapshot(home)).toEqual(before);
});

it("aggregates synthetic active and archived rollouts, reads titles, and leaves inputs unchanged", async () => {
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

  const result = commandOutput(
    runAnalyzer(home, [
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
