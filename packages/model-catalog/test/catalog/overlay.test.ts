import { describe, expect, it } from "bun:test";
import { applyLunaV2Overlay } from "../../src/index.ts";
import { model, source } from "./harness.ts";

describe("Luna V2 model catalog overlay", () => {
  it("changes only Luna compatibility and becomes a no-op after upstream support", () => {
    const input = source();
    const overlaid = applyLunaV2Overlay(input);
    expect(overlaid).toEqual({ catalog: source("v2"), overlay: "applied" });
    expect(input).toEqual(source());
    expect(applyLunaV2Overlay(source("v2")).overlay).toBe("upstream-v2");
  });

  it("fails closed for incomplete, duplicate, or unexpected Luna metadata", () => {
    expect(() =>
      applyLunaV2Overlay({ models: [model("gpt-5.6-luna", "v1")] }),
    ).toThrow("incomplete");
    expect(() =>
      applyLunaV2Overlay({
        models: [...source().models, model("gpt-5.6-luna", "v1")],
      }),
    ).toThrow("found 2");
    const invalid = source();
    const [, , invalidLuna] = invalid.models;
    if (invalidLuna === undefined) {
      throw new Error("missing Luna fixture");
    }

    invalidLuna["multi_agent_version"] = null;
    expect(() => applyLunaV2Overlay(invalid)).toThrow("unexpected");
  });
});
