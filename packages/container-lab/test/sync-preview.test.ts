// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, test } from "bun:test";
import { compareManifests, file } from "./sync-test-support.ts";

describe("three-way comparison", () => {
  test("emits source-only updates and deletes", () => {
    const baseline = { a: file("a", "1"), b: file("b", "1") };
    const result = compareManifests(baseline, { a: file("a", "2") }, baseline);
    expect(result.changes.map(({ path, action }) => [path, action])).toEqual([
      ["a", "upsert"],
      ["b", "delete"],
    ]);
    expect(result.conflicts).toEqual([]);
  });

  test("reports divergent edits but leaves target-only edits alone", () => {
    const baselineB = file("b", "1");
    const baseline = { a: file("a", "1"), b: baselineB };
    const result = compareManifests(
      baseline,
      {
        a: file("a", "2"),
        b: baselineB,
      },
      { a: file("a", "3"), b: file("b", "2") },
    );
    expect(result.conflicts.map(({ path }) => path)).toEqual(["a"]);
    expect(result.changes).toEqual([]);
  });

  test("treats identical concurrent edits as synchronized and ignores target-only deletion", () => {
    const baselineB = file("b", "1");
    const baseline = { a: file("a", "1"), b: baselineB };
    const synchronizedSource = file("a", "2");
    const synchronizedTarget = file("a", "2");
    expect(synchronizedSource).not.toBe(synchronizedTarget);
    const result = compareManifests(
      baseline,
      { a: synchronizedSource, b: baselineB },
      { a: synchronizedTarget },
    );

    expect(result).toEqual({ changes: [], conflicts: [] });
  });
});
