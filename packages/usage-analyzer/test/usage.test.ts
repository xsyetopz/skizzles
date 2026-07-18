// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { describe, expect, test } from "bun:test";
import {
  emptyAggregate,
  mergeAggregate,
  serializableAggregate,
  usageDelta,
  usageFrom,
} from "../src/usage.ts";

describe("usage arithmetic", () => {
  test("clamps cached tokens and computes the comparison proxy", () => {
    expect(
      usageFrom(
        {
          input_tokens: 100,
          cached_input_tokens: 120,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 120,
        },
        0.25,
      ),
    ).toEqual({
      input: 100,
      cached: 100,
      output: 20,
      reasoning: 5,
      total: 120,
      proxy: 45,
    });
  });

  test("never emits negative deltas after a counter reset", () => {
    expect(
      usageDelta(
        {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 3,
          total_tokens: 13,
        },
        {
          input_tokens: 20,
          cached_input_tokens: 5,
          output_tokens: 4,
          total_tokens: 24,
        },
        0.1,
      ),
    ).toEqual({
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      proxy: 0,
    });
  });

  test("merges aggregate counts and unique session identities", () => {
    const target = emptyAggregate();
    target.sessions.add("root");
    const source = emptyAggregate();
    source.inferences = 2;
    source.sessions.add("root");
    source.sessions.add("child");
    source.usage = usageFrom(
      { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      0.1,
    );

    mergeAggregate(target, source);

    expect(serializableAggregate(target)).toMatchObject({
      sessions: 2,
      inferences: 2,
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    });
  });
});
