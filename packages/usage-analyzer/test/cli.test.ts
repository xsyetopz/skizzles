// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { describe, expect, test } from "bun:test";
import { parseArgs, parseDate } from "../src/cli.ts";

describe("usage analyzer CLI", () => {
  test("parses the full option surface", () => {
    expect(
      parseArgs([
        "--from",
        "2026-07-01T00:00:00.000Z",
        "--to",
        "2026-07-02T12:00:00.000Z",
        "--bucket",
        "hour",
        "--cached-weight",
        "0.25",
        "--top",
        "4",
        "--json",
      ]),
    ).toEqual({
      from: Date.parse("2026-07-01T00:00:00.000Z"),
      to: Date.parse("2026-07-02T12:00:00.000Z"),
      bucket: "hour",
      cachedWeight: 0.25,
      top: 4,
      json: true,
    });
  });

  test.each([
    { argv: [], message: "--from is required" },
    {
      argv: ["--from", "invalid"],
      message: "Invalid date/time: invalid",
    },
    {
      argv: ["--from", "2026-07-01", "--cached-weight", "2"],
      message: "--cached-weight must be between 0 and 1",
    },
    {
      argv: ["--from", "2026-07-01", "--top", "0"],
      message: "--top must be a positive integer",
    },
    {
      argv: ["--from", "2026-07-02", "--to", "2026-07-01"],
      message: "--from must not be after --to",
    },
    {
      argv: ["--unknown"],
      message: "Unknown argument: --unknown",
    },
  ])("rejects invalid options: $message", ({ argv, message }) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  test("date-only endpoints use the complete local day", () => {
    const start = new Date(parseDate("2026-07-02"));
    const end = new Date(parseDate("2026-07-02", true));
    expect([
      start.getHours(),
      start.getMinutes(),
      start.getSeconds(),
      start.getMilliseconds(),
    ]).toEqual([0, 0, 0, 0]);
    expect([
      end.getHours(),
      end.getMinutes(),
      end.getSeconds(),
      end.getMilliseconds(),
    ]).toEqual([23, 59, 59, 999]);
  });
});
