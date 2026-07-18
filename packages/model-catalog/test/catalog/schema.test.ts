// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { describe, expect, test } from "bun:test";
import { parseCatalogCache } from "../../src/catalog/schema.ts";

describe("model catalog schema validation", () => {
  test("preserves loose JSON fields while typing the cache envelope", () => {
    expect(
      parseCatalogCache({
        client_version: "0.145.0-alpha.18",
        fetched_at: "2026-07-18T00:00:00.000Z",
        models: [
          {
            slug: "gpt-5.6-sol",
            metadata: { tier: "frontier" },
          },
        ],
        source: "cache",
      }),
    ).toEqual({
      client_version: "0.145.0-alpha.18",
      fetched_at: "2026-07-18T00:00:00.000Z",
      models: [
        {
          slug: "gpt-5.6-sol",
          metadata: { tier: "frontier" },
        },
      ],
      source: "cache",
    });
  });

  test("rejects malformed required fields with a controlled diagnostic", () => {
    for (const value of [
      null,
      [],
      {},
      { client_version: 145, fetched_at: "now", models: [] },
      { client_version: "145", fetched_at: 0, models: [] },
      { client_version: "145", fetched_at: "now", models: null },
      {
        client_version: "0.145.0-alpha.18",
        fetched_at: "2026-07-18T00:00:00.000Z",
        models: [null],
      },
    ]) {
      expect(() => parseCatalogCache(value)).toThrow(
        "model catalog cache is invalid",
      );
    }
  });

  test("rejects class instances because cache values must be JSON objects", () => {
    class CacheEnvelope {
      readonly client_version = "0.145.0-alpha.18";
      readonly fetched_at = "2026-07-18T00:00:00.000Z";
      readonly models: object[] = [];
    }

    expect(() => parseCatalogCache(new CacheEnvelope())).toThrow(
      "model catalog cache is invalid",
    );
    expect(() =>
      parseCatalogCache({
        client_version: "0.145.0-alpha.18",
        fetched_at: "2026-07-18T00:00:00.000Z",
        models: [new Date(0)],
      }),
    ).toThrow("model catalog cache is invalid");
  });
});
