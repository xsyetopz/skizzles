import { describe, expect, it } from "bun:test";
import {
  assertDeterministicFuzz,
  createDeterministicSeedSchedule,
  deterministicExtremeVectorDigests,
  deterministicFuzzCaseCount,
} from "../src/index.ts";

const config = Object.freeze({
  rootSeed: 42,
  seeds: 3,
  casesPerSeed: 10,
  dimensions: 2,
  minimum: -10,
  maximum: 10,
  extremes: Object.freeze([-10, -1, 0, 1, 10]),
});

describe("deterministic fuzz assertions", () => {
  it("uses a stable seed schedule and bounded extreme vectors", async () => {
    expect(createDeterministicSeedSchedule(42, 3)).toEqual(
      createDeterministicSeedSchedule(42, 3),
    );
    const vectors: number[][] = [];
    const result = await assertDeterministicFuzz(config, ({ vector }) => {
      vectors.push([...vector]);
      return vector.every((value) => value >= -10 && value <= 10);
    });
    expect(result.status).toBe("passed");
    expect(result.executedCases).toBe(deterministicFuzzCaseCount(config));
    expect(deterministicExtremeVectorDigests(config)).toHaveLength(6);
    expect(vectors).toContainEqual([-10, -10]);
    expect(vectors).toContainEqual([10, 10]);
    expect(vectors).toContainEqual([-10, 10]);
  });

  it("returns the first reproducible counterexample", async () => {
    const first = await assertDeterministicFuzz(config, ({ vector }) =>
      vector.every((value) => value < 10),
    );
    const second = await assertDeterministicFuzz(config, ({ vector }) =>
      vector.every((value) => value < 10),
    );
    expect(first).toEqual(second);
    expect(first.status).toBe("failed");
    expect(first.counterexample).not.toBeNull();
  });
});
