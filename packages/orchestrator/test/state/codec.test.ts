import { describe, expect, it } from "bun:test";
import { JSON_LIMITS, parseJsonBytes } from "../../src/codec.ts";

const encoder = new TextEncoder();

describe("bounded strict JSON parser", () => {
  it("accepts the exact byte ceiling and rejects one byte over", () => {
    const exact = encoder.encode(`"${"a".repeat(JSON_LIMITS.bytes - 2)}"`);
    const over = encoder.encode(`"${"a".repeat(JSON_LIMITS.bytes - 1)}"`);
    expect(exact.byteLength).toBe(JSON_LIMITS.bytes);
    expect(typeof parseJsonBytes(exact)).toBe("string");
    expect(over.byteLength).toBe(JSON_LIMITS.bytes + 1);
    expect(parseJsonBytes(over)).toBeUndefined();
  });

  it("accepts the exact nesting ceiling and rejects one level over", () => {
    const exact = nestedArray(JSON_LIMITS.depth);
    const over = nestedArray(JSON_LIMITS.depth + 1);
    expect(Array.isArray(parseJsonBytes(exact))).toBe(true);
    expect(parseJsonBytes(over)).toBeUndefined();
  });

  it("accepts the exact value ceiling and rejects one value over", () => {
    const exact = valueArray(JSON_LIMITS.values - 1);
    const over = valueArray(JSON_LIMITS.values);
    expect(parseJsonBytes(exact)).toHaveLength(JSON_LIMITS.values - 1);
    expect(parseJsonBytes(over)).toBeUndefined();
  });
});

function nestedArray(depth: number): Uint8Array {
  return encoder.encode(`${"[".repeat(depth)}null${"]".repeat(depth)}`);
}

function valueArray(items: number): Uint8Array {
  return encoder.encode(
    `[${Array.from({ length: items }, () => "null").join(",")}]`,
  );
}
