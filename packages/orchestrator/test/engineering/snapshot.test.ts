import { describe, expect, it } from "bun:test";
import {
  snapshotArray,
  snapshotOpaqueRecord,
  snapshotRecord,
} from "../../src/engineering/session/snapshot.ts";

describe("descriptor-only engineering snapshots", () => {
  it("rejects accessors without invoking them", () => {
    let reads = 0;
    const value = Object.defineProperty({}, "field", {
      enumerable: true,
      get() {
        reads += 1;
        return "changed";
      },
    });
    expect(snapshotRecord(value, ["field"])).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("rejects proxies before invoking reflection traps", () => {
    let traps = 0;
    const value = new Proxy(
      { field: "value" },
      {
        ownKeys() {
          traps += 1;
          return ["field"];
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          return { enumerable: true, configurable: true, value: "value" };
        },
      },
    );
    expect(snapshotRecord(value, ["field"])).toBeUndefined();
    expect(traps).toBe(0);
  });

  it("rejects symbols, holes, and indexed array accessors", () => {
    expect(
      snapshotRecord({ field: "value", [Symbol("hidden")]: true }, ["field"]),
    ).toBeUndefined();
    expect(
      snapshotOpaqueRecord(
        Object.freeze({ field: "value", [Symbol("hidden")]: true }),
        ["field"],
      ),
    ).toBeUndefined();
    expect(snapshotArray(new Array(1), 1)).toBeUndefined();
    let reads = 0;
    const values: unknown[] = [];
    Object.defineProperty(values, "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return "value";
      },
    });
    values.length = 1;
    expect(snapshotArray(values, 1)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
