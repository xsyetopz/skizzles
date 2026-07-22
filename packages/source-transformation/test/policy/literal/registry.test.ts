import { describe, expect, it } from "bun:test";
import {
  createLiteralRegistry,
  isLiteralRegistrationReceipt,
  isLiteralRegistry,
  isLiteralRegistrySnapshot,
} from "../../../src/policy/literal/registry.ts";

describe("central literal registry", () => {
  it("issues immutable authentic receipts and deterministic snapshots", () => {
    const created = registry();
    const registered = created.register(
      Object.freeze({
        key: "timeoutMs",
        value: 2500,
        description: "Client connection timeout in milliseconds.",
      }),
    );

    expect(registered.status).toBe("registered");
    if (registered.status !== "registered") throw new Error(registered.code);
    expect(registered.receipt.propertySource).toBe("timeoutMs: 2500,");
    expect(registered.receipt.previousRegistryDigest).not.toBe(
      registered.receipt.registryDigest,
    );
    expect(registered.receipt.receiptDigest).toStartWith("sha256:");
    expect(Object.isFrozen(registered.receipt)).toBe(true);
    expect(Object.isFrozen(registered.snapshot)).toBe(true);
    expect(Object.isFrozen(registered.snapshot.entries)).toBe(true);
    expect(Object.isFrozen(registered.snapshot.entries[0])).toBe(true);
    expect(isLiteralRegistrationReceipt(registered.receipt)).toBe(true);
    expect(isLiteralRegistry(created)).toBe(true);
    expect(isLiteralRegistrySnapshot(registered.snapshot)).toBe(true);
  });

  it("rejects malformed, duplicate, forged, and method-copied values", () => {
    const created = registry();
    const first = created.register(
      Object.freeze({
        key: "endpoint",
        value: "tenant-a",
        description: "Stable tenant endpoint.",
      }),
    );
    expect(first.status).toBe("registered");
    expect(
      created.register(
        Object.freeze({
          key: "endpoint",
          value: "tenant-b",
          description: "Conflicting endpoint key.",
        }),
      ),
    ).toEqual({ status: "rejected", code: "DUPLICATE_LITERAL_KEY" });
    expect(
      created.register(
        Object.freeze({
          key: "endpointAlias",
          value: "tenant-a",
          description: "Conflicting endpoint value.",
        }),
      ),
    ).toEqual({ status: "rejected", code: "DUPLICATE_LITERAL_VALUE" });
    expect(
      created.register(
        Object.freeze({ key: "bad-key", value: 1, description: "Invalid." }),
      ),
    ).toEqual({
      status: "rejected",
      code: "INVALID_LITERAL_REGISTRATION",
    });
    expect(
      isLiteralRegistry(
        Object.freeze({
          register: created.register,
          snapshot: created.snapshot,
        }),
      ),
    ).toBe(false);
    expect(
      isLiteralRegistrySnapshot(
        Object.freeze({ ...created.snapshot(), registryDigest: "sha256:fake" }),
      ),
    ).toBe(false);
    if (first.status !== "registered") throw new Error(first.code);
    expect(
      isLiteralRegistrationReceipt(Object.freeze({ ...first.receipt })),
    ).toBe(false);
  });

  it("fails closed on non-frozen and accessor-bearing input", () => {
    expect(createLiteralRegistry({})).toEqual({
      status: "rejected",
      code: "INVALID_LITERAL_REGISTRY_CONFIG",
    });
    const hostile = Object.freeze(
      Object.defineProperty(
        {
          registryId: "source-parameters",
          registryPath: "src/config/parameters.ts",
        },
        "exportName",
        { enumerable: true, get: () => "SOURCE_PARAMETERS" },
      ),
    );
    expect(createLiteralRegistry(hostile)).toEqual({
      status: "rejected",
      code: "INVALID_LITERAL_REGISTRY_CONFIG",
    });
  });
});

function registry() {
  const created = createLiteralRegistry(
    Object.freeze({
      registryId: "source-parameters",
      registryPath: "src/config/parameters.ts",
      exportName: "SOURCE_PARAMETERS",
    }),
  );
  if (created.status !== "created") throw new Error(created.code);
  return created.registry;
}
