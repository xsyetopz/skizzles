// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { expect, it } from "bun:test";
import { join } from "node:path";
import {
  commandOutput,
  fixtureHome,
  rootId,
  runAnalyzer,
  snapshot,
  timestamp,
  writeJsonl,
} from "./harness.ts";

it("prints portable help without touching a Codex home", async () => {
  const home = await fixtureHome();
  const result = commandOutput(runAnalyzer(home, ["--help"]));

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: skizzles-analyze --from");
  expect(result.stdout).not.toContain("packages/usage-analyzer");
  expect(result.stdout).not.toContain("src/main.ts");
  expect(await snapshot(home)).toEqual({});
});

it("human output includes report headings and proxy explanation", async () => {
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
  const result = commandOutput(
    runAnalyzer(home, ["--from", "2026-07-01", "--to", "2026-07-02"]),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Actors");
  expect(result.stdout).toContain("Models");
  expect(result.stdout).toContain("Guardian");
  expect(result.stdout).toContain("Timeline");
  expect(result.stdout).toContain("Proxy = uncached input");
});

it("uses local time for date ranges and hourly bucket labels", async () => {
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

  const result = commandOutput(
    runAnalyzer(
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

it("rejects invalid CLI input with a diagnostic and nonzero exit", async () => {
  const home = await fixtureHome();
  const result = commandOutput(runAnalyzer(home, ["--bucket", "minute"]));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--bucket must be hour or day");
});
