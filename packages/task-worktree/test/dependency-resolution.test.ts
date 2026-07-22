// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { describe, expect, it } from "bun:test";
import {
  createDependencyResolutionService,
  createDependencyResolverAuthority,
} from "../src/dependency/resolution.ts";

function service(resolve: (input: unknown) => unknown) {
  const authority = createDependencyResolverAuthority({
    id: "registry-mirror-v1",
    resolve,
  });
  if (authority.status !== "created") throw new Error("authority rejected");
  const created = createDependencyResolutionService({
    authority: authority.authority,
  });
  if (created.status !== "created") throw new Error("service rejected");
  return created.service;
}

describe("structured dependency resolution", () => {
  it("returns an immutable matched receipt from the configured authority", async () => {
    const result = await service((request) => ({
      ...(request as object),
      resolvedVersion: "1.2.3",
      registry: "mirror.example",
    })).resolve({ ecosystem: "npm", name: "lib", requestedRange: "^1.0.0" });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.receipt.outcome).toBe("matched");
      expect(result.receipt.warning).toBeNull();
      expect(Object.isFrozen(result.receipt)).toBe(true);
    }
  });

  it("turns exact registry mismatch and unavailability into intervention warnings", async () => {
    const mismatch = await service(() => ({
      ecosystem: "npm",
      name: "other",
      requestedRange: "^1.0.0",
      resolvedVersion: "1.2.3",
      registry: "mirror.example",
    })).resolve({ ecosystem: "npm", name: "lib", requestedRange: "^1.0.0" });
    expect(mismatch.status).toBe("resolved");
    if (mismatch.status === "resolved") {
      expect(mismatch.receipt.outcome).toBe("mismatch");
      expect(mismatch.receipt.warning).toContain("exact dependency request");
    }
    const unavailable = await service((request) => ({
      ...(request as object),
      resolvedVersion: null,
      registry: "mirror.example",
    })).resolve({ ecosystem: "npm", name: "lib", requestedRange: "^1.0.0" });
    if (unavailable.status === "resolved")
      expect(unavailable.receipt.outcome).toBe("unavailable");
  });

  it("rejects caller success facts, forged authorities, proxies, and malformed records", async () => {
    expect(
      createDependencyResolutionService({ authority: { id: "forged" } }).status,
    ).toBe("rejected");
    expect(
      createDependencyResolverAuthority(
        new Proxy({ id: "x", resolve: () => ({}) }, {}),
      ).status,
    ).toBe("rejected");
    const invalid = await service(() => ({
      success: true,
      install: true,
    })).resolve({ ecosystem: "npm", name: "lib", requestedRange: "latest" });
    expect(invalid).toEqual({
      status: "rejected",
      code: "INVALID_REGISTRY_RECORD",
    });
    expect(
      await service((request) => ({
        ...(request as object),
        resolvedVersion: "1.2.3",
        registry: "mirror.example",
      })).resolve({
        ecosystem: "npm",
        name: "lib",
        requestedRange: "latest",
        success: true,
      }),
    ).toEqual({ status: "rejected", code: "INVALID_DEPENDENCY_REQUEST" });
  });
});
