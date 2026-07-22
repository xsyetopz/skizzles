// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { describe, expect, it } from "bun:test";
import {
  createTaskWorktreeCommitAuthority,
  parseConventionalCommitMessage,
} from "../src/commit/runtime.ts";
import { createTaskWorktreeDiffAuthority } from "../src/diff/runtime.ts";

function bytes(value: string): readonly number[] {
  return Object.freeze([...new TextEncoder().encode(value)]);
}

function diffFor(paths: readonly string[]) {
  const created = createTaskWorktreeDiffAuthority(
    Object.freeze({
      maxChangedFiles: 10,
      maxAddedLines: 100,
      maxDeletedLines: 100,
      maxChangedBytes: 10_000,
    }),
  );
  if (created.status !== "created")
    throw new Error("diff authority setup failed");
  const result = created.authority.inspect(
    Object.freeze({
      baseline: Object.freeze([]),
      candidate: Object.freeze(
        paths.map((path) =>
          Object.freeze({ path, bytes: bytes("export {};\n") }),
        ),
      ),
    }),
  );
  if (result.status !== "accepted")
    throw new Error("expected one atomic task slice");
  return result;
}

function commitAuthority(
  paths: readonly Readonly<{ path: string; scope: string }>[] = Object.freeze([
    Object.freeze({ path: "packages/task-worktree", scope: "task-worktree" }),
  ]),
) {
  const created = createTaskWorktreeCommitAuthority(
    Object.freeze({
      maxSubjectLength: 72,
      ownedPackagePaths: paths,
    }),
  );
  if (created.status !== "created")
    throw new Error("commit authority setup failed");
  return created.authority;
}

describe("atomic task-slice commit authority", () => {
  it("synthesizes one deterministic conventional commit only from an authentic task slice", () => {
    const diff = diffFor(
      Object.freeze(["packages/task-worktree/src/value.ts"]),
    );
    const slice = diff.plan.slices[0];
    if (slice === undefined) throw new Error("atomic fixture slice missing");
    const authority = commitAuthority();
    const prepared = authority.prepare(
      Object.freeze({
        receipt: diff.receipt,
        slice,
      }),
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(prepared.receipt.plan.mode).toBe("atomic-task-slice");
    expect(prepared.receipt.plan.message.text).toBe(
      `feat(task-worktree): add task-worktree\n\nDiff-Receipt: ${diff.receipt.receiptDigest}\nTask-Slice: ${slice.sliceDigest}`,
    );
    expect(prepared.receipt.plan.message.trailers).toEqual([
      { token: "Diff-Receipt", value: diff.receipt.receiptDigest },
      { token: "Task-Slice", value: slice.sliceDigest },
    ]);
    expect(
      parseConventionalCommitMessage(prepared.receipt.plan.message.text).status,
    ).toBe("valid");
    expect(
      authority.verify(
        Object.freeze({
          input: Object.freeze({
            receipt: diff.receipt,
            slice,
          }),
          receipt: prepared.receipt,
        }),
      ),
    ).toBe(true);
  });

  it("refuses per-file forgery and requires an approval digest for the exact plan", () => {
    const diff = diffFor(
      Object.freeze(["packages/task-worktree/src/value.ts"]),
    );
    const slice = diff.plan.slices[0];
    if (slice === undefined) throw new Error("atomic fixture slice missing");
    const authority = commitAuthority();
    const prepared = authority.prepare(
      Object.freeze({ receipt: diff.receipt, slice }),
    );
    if (prepared.status !== "prepared") throw new Error("plan setup failed");
    expect(
      authority.prepare(
        Object.freeze({
          receipt: diff.receipt,
          slice: Object.freeze({
            ...slice,
            paths: Object.freeze([
              "packages/task-worktree/src/value.ts",
              "other.ts\nTask-Slice: forged",
            ]),
          }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_TASK_SLICE" });
    expect(prepared.receipt.plan.message.text).not.toContain("forged");
    expect(
      authority.authorize(
        Object.freeze({
          receipt: prepared.receipt,
          approvalDigest: "forged",
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_APPROVAL_DIGEST" });
    const authorized = authority.authorize(
      Object.freeze({
        receipt: prepared.receipt,
        approvalDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
    expect(authorized.status).toBe("authorized");
  });

  it("rejects scope ambiguity and unsafe scope/message injection", () => {
    const diff = diffFor(
      Object.freeze(["packages/a/src/a.ts", "packages/b/src/b.ts"]),
    );
    const authority = commitAuthority(
      Object.freeze([
        Object.freeze({ path: "packages/a", scope: "a" }),
        Object.freeze({ path: "packages/b", scope: "b" }),
      ]),
    );
    const split = createTaskWorktreeDiffAuthority(
      Object.freeze({
        maxChangedFiles: 2,
        maxAddedLines: 100,
        maxDeletedLines: 100,
        maxChangedBytes: 10_000,
      }),
    );
    expect(split.status).toBe("created");
    expect(
      authority.prepare(
        Object.freeze({ receipt: diff.receipt, slice: diff.plan.slices[0] }),
      ),
    ).toEqual({ status: "rejected", code: "SCOPE_AMBIGUOUS" });
    expect(
      parseConventionalCommitMessage("feat(scope): add scope\nInjected: true")
        .status,
    ).toBe("invalid");
    expect(
      parseConventionalCommitMessage(
        "feat(scope): add scope\r\n\r\nTrailer: injected",
      ).status,
    ).toBe("invalid");
    expect(
      parseConventionalCommitMessage(
        "feat(scope): add scope\n\nReviewed-by: A\nReviewed-by: B",
      ).status,
    ).toBe("invalid");
    expect(
      parseConventionalCommitMessage("feat(scope): add scope\n\nReviewed-by: A")
        .status,
    ).toBe("valid");
  });
});
