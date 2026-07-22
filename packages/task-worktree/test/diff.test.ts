// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { describe, expect, it } from "bun:test";
import {
  createTaskWorktreeDiffAuthority,
  isTaskWorktreeDiffReceipt,
} from "../src/diff/runtime.ts";

function bytes(value: string): readonly number[] {
  return Object.freeze([...new TextEncoder().encode(value)]);
}

function file(path: string, content: string | readonly number[]) {
  return Object.freeze({
    path,
    bytes:
      typeof content === "string"
        ? bytes(content)
        : Object.freeze([...content]),
  });
}

function input(
  baseline: readonly ReturnType<typeof file>[],
  candidate: readonly ReturnType<typeof file>[],
) {
  return Object.freeze({
    baseline: Object.freeze([...baseline]),
    candidate: Object.freeze([...candidate]),
  });
}

function authority(
  overrides: Partial<
    Record<
      | "maxAddedLines"
      | "maxChangedBytes"
      | "maxChangedFiles"
      | "maxDeletedLines",
      number
    >
  > = {},
) {
  const created = createTaskWorktreeDiffAuthority(
    Object.freeze({
      maxChangedFiles: overrides.maxChangedFiles ?? 10,
      maxAddedLines: overrides.maxAddedLines ?? 100,
      maxDeletedLines: overrides.maxDeletedLines ?? 100,
      maxChangedBytes: overrides.maxChangedBytes ?? 10_000,
    }),
  );
  if (created.status !== "created")
    throw new Error("diff authority setup failed");
  return created.authority;
}

describe("exact task worktree diff authority", () => {
  it("accounts exact text, CRLF, binary, empty, delete, and rename-shaped states", () => {
    const diff = authority();
    const result = diff.inspect(
      input(
        Object.freeze([
          file("delete.txt", "gone\n"),
          file("empty.txt", ""),
          file("line.txt", "a\r\nb\r\n"),
          file("old-name.ts", "export const value = 1;\n"),
          file("raw.bin", Object.freeze([0, 255, 1])),
        ]),
        Object.freeze([
          file("empty.txt", ""),
          file("line.txt", "a\nb\n"),
          file("new-name.ts", "export const value = 1;\n"),
          file("raw.bin", Object.freeze([0, 255, 2])),
        ]),
      ),
    );
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.receipt.metrics.changedFiles).toBe(5);
    expect(result.receipt.metrics.addedFiles).toBe(1);
    expect(result.receipt.metrics.deletedFiles).toBe(2);
    expect(result.receipt.metrics.addedLines).toBe(1);
    expect(result.receipt.metrics.deletedLines).toBe(2);
    expect(result.receipt.changes.map(({ path }) => path)).toEqual([
      "delete.txt",
      "line.txt",
      "new-name.ts",
      "old-name.ts",
      "raw.bin",
    ]);
    expect(
      result.receipt.changes.find(({ path }) => path === "line.txt")
        ?.addedLines,
    ).toBe(0);
    expect(
      result.receipt.changes.find(({ path }) => path === "line.txt")
        ?.deletedLines,
    ).toBe(0);
    expect(
      result.receipt.changes.find(({ path }) => path === "raw.bin")?.binary,
    ).toBe(true);
  });

  it("binds authentic receipts to exact immutable baseline and candidate bytes", () => {
    const diff = authority();
    const exact = input(
      Object.freeze([file("src/value.ts", "before\n")]),
      Object.freeze([file("src/value.ts", "after\n")]),
    );
    const result = diff.inspect(exact);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(isTaskWorktreeDiffReceipt(result.receipt)).toBe(true);
    expect(
      diff.verify(Object.freeze({ input: exact, receipt: result.receipt })),
    ).toBe(true);
    const forged = Object.freeze({
      ...result.receipt,
      metrics: Object.freeze({ ...result.receipt.metrics, addedLines: 0 }),
    });
    expect(isTaskWorktreeDiffReceipt(forged)).toBe(false);
    expect(diff.verify(Object.freeze({ input: exact, receipt: forged }))).toBe(
      false,
    );
    const changedCandidate = input(
      Object.freeze([file("src/value.ts", "before\n")]),
      Object.freeze([file("src/value.ts", "after again\n")]),
    );
    expect(
      diff.verify(
        Object.freeze({ input: changedCandidate, receipt: result.receipt }),
      ),
    ).toBe(false);
  });

  it("uses host-owned thresholds to issue a stable complete non-overlapping split plan", () => {
    const diff = authority({ maxChangedFiles: 1 });
    const result = diff.inspect(
      input(
        Object.freeze([]),
        Object.freeze([file("a.ts", "a\n"), file("b.ts", "b\n")]),
      ),
    );
    expect(result.status).toBe("split-required");
    if (result.status !== "split-required") return;
    expect(result.plan.slices.map(({ paths }) => paths)).toEqual([
      ["a.ts"],
      ["b.ts"],
    ]);
    expect(new Set(result.plan.slices.flatMap(({ paths }) => paths)).size).toBe(
      2,
    );
    expect(result.plan.slices.map(({ sliceDigest }) => sliceDigest)).toEqual(
      result.plan.slices.map(({ sliceDigest }) => sliceDigest),
    );
  });

  it("rejects threshold-edge changes that cannot be atomically sliced", () => {
    const diff = authority({ maxAddedLines: 1 });
    const result = diff.inspect(
      input(
        Object.freeze([]),
        Object.freeze([file("two-lines.ts", "one\ntwo\n")]),
      ),
    );
    expect(result).toEqual({ status: "rejected", code: "UNSPLITTABLE_CHANGE" });
  });

  it("bounds adversarial line diffs by host ceilings before quadratic work", () => {
    const diff = authority({
      maxAddedLines: 1,
      maxChangedBytes: 1_000_000,
      maxDeletedLines: 1,
    });
    const baseline = Array.from({ length: 30_000 }, () => "before").join("\n");
    const candidate = Array.from({ length: 30_000 }, () => "after").join("\n");
    const result = diff.inspect(
      input(
        Object.freeze([file("adversarial.txt", baseline)]),
        Object.freeze([file("adversarial.txt", candidate)]),
      ),
    );
    expect(result).toEqual({ status: "rejected", code: "UNSPLITTABLE_CHANGE" });
  });

  it("rejects caller metrics, unsorted paths, mutable bytes, and unsafe paths", () => {
    const diff = authority();
    expect(
      diff.inspect(
        Object.freeze({
          baseline: Object.freeze([]),
          candidate: Object.freeze([]),
          changedFiles: 0,
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_EXACT_INPUT" });
    expect(
      diff.inspect(
        input(
          Object.freeze([file("b.ts", "b"), file("a.ts", "a")]),
          Object.freeze([]),
        ),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_EXACT_INPUT" });
    expect(
      diff.inspect(
        Object.freeze({
          baseline: Object.freeze([]),
          candidate: Object.freeze([
            Object.freeze({ path: "../escape.ts", bytes: [1] }),
          ]),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_EXACT_INPUT" });
  });
});
