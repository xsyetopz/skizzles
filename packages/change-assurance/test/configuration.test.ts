// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import {
  createConfigurationRegistry,
  isConfigurationRegistry,
  isConfigurationWriteAuthorized,
  isConfigurationWriteReceipt,
  readConfigurationWriteBytes,
} from "../src/index.ts";

describe("audited configuration registry", () => {
  function createRegistry() {
    return createConfigurationRegistry({
      definitions: [
        { key: "endpoint", path: "config/production.json", kind: "string" },
        { key: "retries", path: "config/production.json", kind: "number" },
      ],
    });
  }

  it("materializes exact registered values and binds path/digest", () => {
    const registry = createRegistry();
    expect(isConfigurationRegistry(registry)).toBe(true);
    expect(
      registry.register({ key: "endpoint", value: "https://service.invalid" })
        .ok,
    ).toBe(true);
    expect(registry.register({ key: "retries", value: 3 }).ok).toBe(true);
    const materialized = registry.materialize({ key: "endpoint" });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) {
      return;
    }
    expect(isConfigurationWriteReceipt(materialized.receipt)).toBe(true);
    const bytes = readConfigurationWriteBytes(materialized.receipt);
    expect(bytes).toEqual(materialized.bytes);
    expect(
      isConfigurationWriteAuthorized(materialized.receipt, {
        path: "config/production.json",
        bytes: materialized.bytes,
      }),
    ).toBe(true);
  });

  it("rejects forged paths, bytes, receipts, and unregistered keys", () => {
    const registry = createRegistry();
    expect(registry.register({ key: "unknown", value: "x" }).ok).toBe(false);
    expect(registry.register({ key: "retries", value: "three" }).ok).toBe(
      false,
    );
    expect(
      registry.register({ key: "endpoint", value: "https://service.invalid" })
        .ok,
    ).toBe(true);
    const materialized = registry.materialize({ key: "endpoint" });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) {
      return;
    }
    const mutated = new Uint8Array(materialized.bytes);
    mutated[0] = mutated[0] === 123 ? 91 : 123;
    expect(
      isConfigurationWriteAuthorized(materialized.receipt, {
        path: "config/other.json",
        bytes: materialized.bytes,
      }),
    ).toBe(false);
    expect(
      isConfigurationWriteAuthorized(materialized.receipt, {
        path: "config/production.json",
        bytes: mutated,
      }),
    ).toBe(false);
    expect(
      isConfigurationWriteAuthorized(
        { ...materialized.receipt },
        { path: "config/production.json", bytes: materialized.bytes },
      ),
    ).toBe(false);
  });

  it("rejects non-configuration paths and duplicate definitions", () => {
    expect(() =>
      createConfigurationRegistry({
        definitions: [{ key: "source", path: "src/app.ts", kind: "string" }],
      }),
    ).toThrow();
    expect(() =>
      createConfigurationRegistry({
        definitions: [
          { key: "endpoint", path: "config/one.json", kind: "string" },
          { key: "endpoint", path: "config/two.json", kind: "string" },
        ],
      }),
    ).toThrow();
  });

  it("rejects accessor-backed values without invoking accessors", () => {
    let executed = false;
    const input = { key: "endpoint", value: "safe" };
    Object.defineProperty(input, "value", {
      get: () => {
        executed = true;
        return "hidden";
      },
      enumerable: true,
    });
    const registry = createRegistry();
    expect(registry.register(input).ok).toBe(false);
    expect(executed).toBe(false);
  });
});
