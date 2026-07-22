// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import {
  type ContinuationBindings,
  ContinuationLedger,
} from "../../src/engineering/continuation.ts";

const hexLength = 64;
const firstDigest = `sha256:${"a".repeat(hexLength)}` as const;
const secondDigest = `sha256:${"b".repeat(hexLength)}` as const;

const bindings: ContinuationBindings = Object.freeze({
  taskEpochDigest: firstDigest,
  requestDigest: firstDigest,
  repositoryId: "repo-a",
  treeDigest: firstDigest,
  baselineDigest: firstDigest,
  provenanceDigest: firstDigest,
  candidateDigest: firstDigest,
  cursorDigest: firstDigest,
  budgetEpoch: "epoch-a",
});

describe("same-process continuation ledger", () => {
  it("atomically consumes one opaque continuation", () => {
    const ledger = new ContinuationLedger<{ readonly stage: string }>();
    const issued = ledger.issue(
      bindings,
      Object.freeze({ stage: "source-advance" }),
    );
    if (issued.status !== "issued") throw new Error("issuance rejected");
    const { continuation } = issued;
    expect(ledger.consume(continuation, bindings)).toEqual({
      status: "accepted",
      state: { stage: "source-advance" },
    });
    expect(ledger.consume(continuation, bindings)).toEqual({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });
  });

  it("rejects forged handles without exposing stored state", () => {
    const ledger = new ContinuationLedger<object>();
    const issued = ledger.issue(bindings, Object.freeze({ secret: true }));
    if (issued.status !== "issued") throw new Error("issuance rejected");
    const { continuation } = issued;
    expect(ledger.consume({ ...continuation }, bindings)).toEqual({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });
  });

  it("consumes and rejects every binding or epoch drift", () => {
    const ledger = new ContinuationLedger<object>();
    const issued = ledger.issue(bindings, Object.freeze({ stage: "paused" }));
    if (issued.status !== "issued") throw new Error("issuance rejected");
    const { continuation } = issued;
    expect(
      ledger.consume(continuation, {
        ...bindings,
        candidateDigest: secondDigest,
      }),
    ).toEqual({ status: "rejected", code: "CONTINUATION_DRIFTED" });
    expect(ledger.consume(continuation, bindings)).toEqual({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });
    const epochIssued = ledger.issue(
      bindings,
      Object.freeze({ stage: "paused" }),
    );
    if (epochIssued.status !== "issued") throw new Error("issuance rejected");
    const epochContinuation = epochIssued.continuation;
    expect(
      ledger.consume(epochContinuation, {
        ...bindings,
        budgetEpoch: "epoch-b",
      }),
    ).toEqual({ status: "rejected", code: "CONTINUATION_DRIFTED" });
  });

  it("rejects malformed bindings and mutable resumable state", () => {
    const ledger = new ContinuationLedger<object>();
    expect(ledger.issue(bindings, { mutable: true })).toEqual({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });
    expect(
      ledger.issue(bindings, Object.freeze({ nested: { mutable: true } })),
    ).toEqual({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });
    expect(
      Reflect.apply(ContinuationLedger.prototype.issue, ledger, [
        { ...bindings, candidateDigest: "not-a-digest" },
        Object.freeze({ frozen: true }),
      ]),
    ).toEqual({ status: "rejected", code: "CONTINUATION_REJECTED" });
  });
});
