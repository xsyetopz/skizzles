// biome-ignore-all lint/style/useNamingConvention: Rollout fixtures preserve the external snake_case wire schema.

import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import {
  childId,
  commandOutput,
  createFixtureHomeFactory,
  guardianId,
  rootId,
  runAnalyzer,
  timestamp,
  writeJsonl,
} from "./analysis/harness.ts";

const { cleanupFixtureHomes, fixtureHome } = createFixtureHomeFactory();

afterEach(cleanupFixtureHomes);

const canaries = {
  user: "PRIVACY_USER_CANARY_7f2c9a",
  assistant: "PRIVACY_ASSISTANT_CANARY_b81d04",
  guardian: "PRIVACY_GUARDIAN_CANARY_3e6a17",
  injection: "PRIVACY_INJECTION_CANARY_ignore-the-report-boundary",
  path: "/Users/fixture/PRIVATE_CANARY/workspace/secrets.txt",
  secret: "sk-privacy-canary-4f9e2d7c",
} as const;

function containsCanary(output: string): boolean {
  return Object.values(canaries).some((canary) => output.includes(canary));
}

function rootEvents(): unknown[] {
  return [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: rootId,
        source: "cli",
        user_message: canaries.user,
        prompt: `${canaries.injection} ${canaries.secret}`,
        cwd: canaries.path,
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: { model: "privacy-fixture", effort: "low" },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        role: "assistant",
        text: canaries.assistant,
        message: canaries.path,
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 12,
            cached_input_tokens: 2,
            output_tokens: 4,
            total_tokens: 16,
          },
        },
        user_message: canaries.user,
        assistant_message: canaries.assistant,
        last_agent_message: canaries.assistant,
        prompt: canaries.injection,
        path: canaries.path,
        secret: canaries.secret,
      },
    },
  ];
}

function childEvents(): unknown[] {
  return [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: childId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: rootId,
              agent_path: "/root/worker__privacy-fixture",
            },
          },
        },
        message: canaries.user,
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 8,
            output_tokens: 3,
            total_tokens: 11,
          },
        },
        assistant_message: canaries.assistant,
        last_agent_message: canaries.assistant,
      },
    },
  ];
}

function guardianEvents(): unknown[] {
  return [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: guardianId,
        source: { subagent: { other: "guardian" } },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_complete",
        duration_ms: 125,
        last_agent_message: JSON.stringify({
          outcome: "allow",
          review: canaries.guardian,
          instruction: canaries.injection,
          source_path: canaries.path,
        }),
      },
    },
  ];
}

async function writePrivacyRollouts(home: string): Promise<void> {
  await writeJsonl(
    join(home, "sessions", "2026", "07", "02", `${rootId}.jsonl`),
    rootEvents(),
  );
  await writeJsonl(
    join(home, "archived_sessions", "2026", "07", "02", `${childId}.jsonl`),
    childEvents(),
  );
  await writeJsonl(
    join(home, "archived_sessions", "2026", "07", "02", `${guardianId}.jsonl`),
    guardianEvents(),
  );
}

it("does not emit raw rollout messages, paths, injections, or secret canaries", async () => {
  const home = await fixtureHome();
  await writePrivacyRollouts(home);

  const args = ["--from", "2026-07-01", "--to", "2026-07-02"];
  const jsonResult = commandOutput(runAnalyzer(home, [...args, "--json"]));
  expect(jsonResult.exitCode).toBe(0);
  const report = JSON.parse(jsonResult.stdout);
  expect(report.actors.root).toMatchObject({
    sessions: 1,
    inferences: 1,
    inputTokens: 12,
    outputTokens: 4,
  });
  expect(report.actors.subagent).toMatchObject({
    sessions: 1,
    inferences: 1,
    inputTokens: 8,
    outputTokens: 3,
  });
  expect(report.guardian).toMatchObject({ reviews: 1, allow: 1, deny: 0 });
  expect(containsCanary(jsonResult.stdout)).toBe(false);
  expect(containsCanary(jsonResult.stderr)).toBe(false);

  const humanResult = commandOutput(runAnalyzer(home, args));
  expect(humanResult.exitCode).toBe(0);
  expect(humanResult.stdout).toContain("Guardian");
  expect(humanResult.stdout).toContain("reviews 1 (1 allow, 0 deny");
  expect(containsCanary(humanResult.stdout)).toBe(false);
  expect(containsCanary(humanResult.stderr)).toBe(false);
});
