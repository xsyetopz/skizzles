import { describe, expect, it } from "bun:test";
import { JSON_LIMITS } from "../../src/codec.ts";
import { recoverRequestBytes } from "../../src/index.ts";
import { createHarness, requestBytes } from "../facade/support.ts";

describe("strict request normalization", () => {
  it("derives every semantic field from the exact raw envelope", () => {
    const { orchestrator } = createHarness();
    const raw = requestBytes({ action: "DELETE", subject: "canonical record" });
    const result = orchestrator.normalize(raw);
    if (result.status === "rejected") {
      throw new Error("fixture rejected");
    }
    expect(result.request.canonical.action).toBe("delete");
    expect(result.request.canonical.subject).toBe("canonical record");
    expect(result.request.canonical.semanticDescriptors).toEqual(["atomic"]);
    expect(result.request.canonical.negations).toEqual([
      "do not remove audit logging",
    ]);
    expect(result.request.canonical.quotedText).toEqual(['"Keep THIS copy"']);
    expect(result.request.source.userCopy).toContain("report `AuthToken`");
    expect(recoverRequestBytes(result.request)).toEqual(raw);
  });

  it("rejects duplicate, unknown, malformed, non-UTF8, and null envelopes", () => {
    const { orchestrator } = createHarness();
    const valid = new TextDecoder().decode(requestBytes());
    const duplicate = valid.replace('"version":1', '"version":1,"version":1');
    const unknown = valid.replace('"version":1', '"version":1,"checks":[]');
    for (const input of [
      new TextEncoder().encode(duplicate),
      new TextEncoder().encode(unknown),
      new TextEncoder().encode("{"),
      new Uint8Array([0xff]),
      null,
    ]) {
      expect(() => orchestrator.normalize(input)).not.toThrow();
      expect(orchestrator.normalize(input)).toEqual({
        status: "rejected",
        code: "INVALID_REQUEST_ENVELOPE",
      });
    }
  });

  it("snapshots raw bytes and binds style variants without losing semantics", () => {
    const { orchestrator } = createHarness();
    const raw = requestBytes({ descriptors: ["awesome", "atomic"] });
    const normalized = orchestrator.normalize(raw);
    if (normalized.status === "rejected") {
      throw new Error("fixture rejected");
    }
    raw.fill(0);
    expect(normalized.request.canonical.semanticDescriptors).toEqual([
      "atomic",
    ]);
    expect(normalized.request.source.descriptors).toEqual([
      "awesome",
      "atomic",
    ]);
    expect(recoverRequestBytes(normalized.request)?.[0]).not.toBe(0);
    expect(normalized.request.intentDigest).toStartWith("sha256:");
    expect(normalized.request.rawDigest).toStartWith("sha256:");
  });

  it("rejects oversized requests before copying and keeps 256-value arrays valid", () => {
    const { orchestrator } = createHarness();
    const exact = exactLimitRequest();
    expect(exact.byteLength).toBe(JSON_LIMITS.bytes);
    expect(orchestrator.normalize(exact).status).toBe("accepted");

    const normalMaximum = requestBytes({
      descriptors: Array.from({ length: 256 }, (_, index) => `item-${index}`),
    });
    expect(orchestrator.normalize(normalMaximum).status).toBe("accepted");

    const oversized = new Uint8Array(JSON_LIMITS.bytes + 1);
    oversized.fill(0x20);
    expect(() => orchestrator.normalize(oversized)).not.toThrow();
    expect(orchestrator.normalize(oversized)).toEqual({
      status: "rejected",
      code: "INVALID_REQUEST_ENVELOPE",
    });
  });

  it("maps nesting and value-limit overflow to invalid request results", () => {
    const { orchestrator } = createHarness();
    let nestedValue: unknown = "value";
    for (let depth = 0; depth <= JSON_LIMITS.depth; depth += 1) {
      nestedValue = [nestedValue];
    }
    const nested = requestBytes({
      descriptors: nestedValue,
    });
    const excessiveValues = requestBytes({
      descriptors: Array.from({ length: JSON_LIMITS.values }, () => "x"),
    });
    for (const input of [nested, excessiveValues]) {
      expect(() => orchestrator.normalize(input)).not.toThrow();
      expect(orchestrator.normalize(input)).toEqual({
        status: "rejected",
        code: "INVALID_REQUEST_ENVELOPE",
      });
    }
  });
});

function exactLimitRequest(): Uint8Array {
  const descriptors: string[] = [];
  const userCopy = "u".repeat(16_384);
  while (true) {
    const current = requestBytes({ descriptors, userCopy });
    const remaining = JSON_LIMITS.bytes - current.byteLength;
    const withEmpty = requestBytes({
      descriptors: [...descriptors, ""],
      userCopy,
    });
    const entryOverhead = withEmpty.byteLength - current.byteLength;
    if (remaining - entryOverhead <= 4096) {
      descriptors.push("d".repeat(remaining - entryOverhead));
      return requestBytes({ descriptors, userCopy });
    }
    descriptors.push("d".repeat(4096));
  }
}
