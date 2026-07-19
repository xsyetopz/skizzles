// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  childId,
  commandOutput,
  createFixtureHomeFactory,
  rootId,
  runAnalyzer,
  timestamp,
  writeJsonl,
} from "../analysis/harness.ts";

const { cleanupFixtureHomes, fixtureHome } = createFixtureHomeFactory();

afterEach(cleanupFixtureHomes);

it("preserves role and legacy tier attribution for historical task names", async () => {
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

  const result = commandOutput(
    runAnalyzer(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]),
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

it("ignores malformed JSONL while preserving valid usage", async () => {
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

  const result = commandOutput(
    runAnalyzer(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).actors.root).toMatchObject({
    sessions: 1,
    inferences: 1,
    inputTokens: 7,
    outputTokens: 3,
  });
});

it("selects the largest active or archived duplicate and reports one rollout", async () => {
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

  const result = commandOutput(
    runAnalyzer(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]),
  );
  const report = JSON.parse(result.stdout);
  expect(result.exitCode).toBe(0);
  expect(report.range.rolloutFiles).toBe(1);
  expect(report.actors.root).toMatchObject({
    inputTokens: 20,
    outputTokens: 5,
  });
});

it("excludes inherited fork usage before the child task starts", async () => {
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
    commandOutput(
      runAnalyzer(home, [
        "--from",
        "2026-07-01",
        "--to",
        "2026-07-02",
        "--json",
      ]),
    ).stdout,
  );
  expect(report.actors.subagent).toMatchObject({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});
