import { describe, expect, it } from "bun:test";
import { compareJsonSemantics } from "../../src/index.ts";

describe("JSON semantic comparison", () => {
  it("compares nested records independently of member declaration order", () => {
    const result = compareJsonSemantics(
      { status: "ready", payload: { count: 2, flags: [true, false] } },
      { payload: { flags: [true, false], count: 2 }, status: "ready" },
    );

    expect(result.status).toBe("equal");
    expect(result.domain).toBe("json-value");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("uses strict scalar kinds and ordered array semantics", () => {
    const kindMismatch = compareJsonSemantics({ value: "1" }, { value: 1 });
    const orderMismatch = compareJsonSemantics([1, 2], [2, 1]);

    expect(kindMismatch).toEqual({
      status: "different",
      domain: "json-value",
      difference: {
        code: "KIND_MISMATCH",
        path: ["value"],
        actualKind: "string",
        expectedKind: "number",
      },
    });
    expect(orderMismatch).toEqual({
      status: "different",
      domain: "json-value",
      difference: {
        code: "VALUE_MISMATCH",
        path: [0],
        actualKind: "number",
        expectedKind: "number",
      },
    });
    if (kindMismatch.status !== "different") {
      throw new Error("expected a semantic difference");
    }
    expect(Object.isFrozen(kindMismatch.difference)).toBe(true);
    expect(Object.isFrozen(kindMismatch.difference.path)).toBe(true);
  });

  it("reports deterministic missing and unexpected structure", () => {
    const missing = compareJsonSemantics(
      { nested: { a: true } },
      { nested: { a: true, b: false } },
    );
    const unexpected = compareJsonSemantics([1, 2], [1]);

    expect(missing).toEqual({
      status: "different",
      domain: "json-value",
      difference: {
        code: "MISSING_MEMBER",
        path: ["nested", "b"],
        actualKind: "missing",
        expectedKind: "boolean",
      },
    });
    expect(unexpected).toEqual({
      status: "different",
      domain: "json-value",
      difference: {
        code: "UNEXPECTED_MEMBER",
        path: [1],
        actualKind: "number",
        expectedKind: "missing",
      },
    });
  });
});

describe("JSON semantic comparison safety", () => {
  it("rejects values outside the language-neutral JSON domain", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);

    expect(compareJsonSemantics({ value: undefined }, {}).status).toBe(
      "rejected",
    );
    expect(compareJsonSemantics(Number.NaN, 0).status).toBe("rejected");
    expect(compareJsonSemantics(new Date(0), {}).status).toBe("rejected");
    expect(compareJsonSemantics(sparse, []).status).toBe("rejected");
    expect(compareJsonSemantics(cyclic, {}).status).toBe("rejected");
  });

  it("rejects accessors without executing them", () => {
    let reads = 0;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get(): string {
        reads += 1;
        return "hidden";
      },
    });

    const result = compareJsonSemantics(value, {});

    expect(result).toEqual({
      status: "rejected",
      domain: "json-value",
      side: "actual",
      code: "UNSAFE_OBJECT",
      path: ["secret"],
    });
    expect(reads).toBe(0);
  });

  it("fails closed for hostile objects", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile");
        },
      },
    );

    expect(compareJsonSemantics(hostile, {})).toEqual({
      status: "rejected",
      domain: "json-value",
      side: "actual",
      code: "UNSAFE_OBJECT",
      path: [],
    });
    expect(compareJsonSemantics({}, hostile)).toEqual({
      status: "rejected",
      domain: "json-value",
      side: "expected",
      code: "UNSAFE_OBJECT",
      path: [],
    });
  });
});
