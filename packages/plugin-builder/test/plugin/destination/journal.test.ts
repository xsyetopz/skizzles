import { describe, expect, it } from "bun:test";
import {
  deserialize,
  matches,
  parseJournal,
  serialized,
} from "../../../src/plugin/destination/journal.ts";

describe("plugin destination journal identities", () => {
  it("round-trips bigint identities without numeric narrowing", () => {
    const identity = {
      dev: 9_007_199_254_740_993n,
      ino: 18_446_744_073_709_551_615n,
    };
    const encoded = serialized(identity);
    expect(encoded).toEqual({
      dev: "9007199254740993",
      ino: String(identity.ino),
    });
    expect(deserialize(encoded)).toEqual(identity);
    expect(matches(identity, encoded)).toBe(true);
    expect(matches({ ...identity, ino: identity.ino - 1n }, encoded)).toBe(
      false,
    );
    expect(() =>
      parseJournal({
        original: { identity: { dev: "01", ino: "2" }, present: true },
        state: "active",
        version: 2,
      }),
    ).toThrow("invalid identity");
  });
});
