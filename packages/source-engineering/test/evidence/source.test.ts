// biome-ignore lint/correctness/noUnresolvedImports: Biome does not resolve Bun built-in modules.
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createSourceEvidence } from "../../src/evidence/source.ts";

const bytes = Object.freeze([...new TextEncoder().encode("export {};\n")]);
const digest = (value: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const baselineDigest = digest(Uint8Array.from(bytes));
const bindings = Object.freeze({
  requestDigest: digest("request"),
  repositoryId: "repo",
  rootIdentity: "root-id",
  treeDigest: digest("tree"),
  configDigest: digest("config"),
  path: "src/index.ts",
  language: "typescript",
});

describe("source evidence", () => {
  it("captures and recovers authenticated immutable baseline evidence", async () => {
    const evidence = authority();
    const result = await evidence.capture(bindings);
    expect(result.status).toBe("captured");
    if (result.status !== "captured") throw new Error(result.code);
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect("baselineBytes" in result.receipt).toBe(false);
    expect("filesystemRoot" in result.receipt).toBe(false);
    expect(evidence.recoverCapture(result.receipt)).toEqual({
      status: "recovered",
      baselineBytes: bytes,
    });
    expect(evidence.recoverCapture({ ...result.receipt })).toEqual({
      status: "rejected",
      code: "FORGED_CAPTURE",
    });
  });

  it("binds template provenance and authentic recovery to the capture", async () => {
    const evidence = authority();
    const captured = await evidence.capture(bindings);
    if (captured.status !== "captured") throw new Error(captured.code);
    const result = await evidence.materializeTemplate({
      capture: captured.receipt,
      templateId: "typescript-node",
      nodeSource: "export const value = 1;",
    });
    expect(result.status).toBe("materialized");
    if (result.status !== "materialized") throw new Error(result.code);
    expect(result.receipt).toMatchObject({
      requestDigest: bindings.requestDigest,
      repositoryId: bindings.repositoryId,
      rootIdentity: bindings.rootIdentity,
      path: bindings.path,
      tool: "template-tool",
      toolVersion: "1.0.0",
    });
    expect(evidence.recoverTemplate(result.receipt)).toEqual({
      status: "recovered",
      nodeSource: "export const value = 1;",
    });
    expect(evidence.recoverTemplate({ ...result.receipt })).toEqual({
      status: "rejected",
      code: "TEMPLATE_REJECTED",
    });
  });

  it("rejects unsupported, stale, mutable, forged, accessor, and proxy evidence", async () => {
    expect(
      await authority().capture({ ...bindings, language: "rust" }),
    ).toEqual({ status: "rejected", code: "UNSUPPORTED_LANGUAGE" });
    expect(await authority({ stale: true }).capture(bindings)).toEqual({
      status: "rejected",
      code: "SOURCE_CAPTURE_STALE",
    });
    expect(await authority({ mutable: true }).capture(bindings)).toEqual({
      status: "rejected",
      code: "SOURCE_CAPTURE_REJECTED",
    });
    expect(await authority({ proxy: true }).capture(bindings)).toEqual({
      status: "rejected",
      code: "SOURCE_CAPTURE_REJECTED",
    });
    expect(await authority({ accessorArray: true }).capture(bindings)).toEqual({
      status: "rejected",
      code: "SOURCE_CAPTURE_REJECTED",
    });
    let accessed = false;
    const hostile = Object.defineProperty({}, "requestDigest", {
      enumerable: true,
      get: () => {
        accessed = true;
        return bindings.requestDigest;
      },
    });
    expect(await authority().capture(hostile)).toEqual({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(accessed).toBe(false);
    expect(await authority().capture(new Proxy({ ...bindings }, {}))).toEqual({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(
      await authority().capture({
        ...bindings,
        [Symbol("hostile")]: true,
      }),
    ).toEqual({ status: "rejected", code: "INVALID_INPUT" });
  });

  it("rejects stale template bindings and content not bound to node source", async () => {
    const stale = authority({ staleTemplate: true });
    const captured = await stale.capture(bindings);
    if (captured.status !== "captured") throw new Error(captured.code);
    expect(
      await stale.materializeTemplate({
        capture: captured.receipt,
        templateId: "typescript-node",
        nodeSource: "export {};",
      }),
    ).toEqual({ status: "rejected", code: "TEMPLATE_STALE" });

    const changed = authority({ changedContent: true });
    const capturedChanged = await changed.capture(bindings);
    if (capturedChanged.status !== "captured") {
      throw new Error(capturedChanged.code);
    }
    expect(
      await changed.materializeTemplate({
        capture: capturedChanged.receipt,
        templateId: "typescript-node",
        nodeSource: "export {};",
      }),
    ).toEqual({ status: "rejected", code: "TEMPLATE_REJECTED" });
  });
});

function authority(
  options: {
    stale?: boolean;
    mutable?: boolean;
    proxy?: boolean;
    accessorArray?: boolean;
    staleTemplate?: boolean;
    changedContent?: boolean;
  } = {},
) {
  const created = createSourceEvidence({
    sourceCaptureAuthority: {
      capture: (input: unknown) => {
        const source = dataRecord(input);
        let baseline: readonly number[] = bytes;
        if (options.accessorArray) {
          const hostile: number[] = [];
          Object.defineProperty(hostile, "0", {
            enumerable: true,
            get: () => 1,
          });
          baseline = Object.freeze(hostile);
        }
        const value = {
          ...Object.fromEntries(source),
          treeDigest: options.stale
            ? digest("stale")
            : source.get("treeDigest"),
          baselineDigest,
          baselineBytes: baseline,
        };
        if (options.proxy) return new Proxy(Object.freeze(value), {});
        return options.mutable ? value : Object.freeze(value);
      },
    },
    templateAuthority: {
      materialize: (input: unknown) => {
        const request = dataRecord(input);
        const binding = [...request].filter(([key]) => key !== "nodeSource");
        return Object.freeze({
          ...Object.fromEntries(binding),
          repositoryId: options.staleTemplate
            ? "stale"
            : request.get("repositoryId"),
          templateDigest: digest("template"),
          tool: "template-tool",
          toolVersion: "1.0.0",
          contentDigest: options.changedContent
            ? digest("different")
            : request.get("nodeSourceDigest"),
          schemaDigest: digest("schema"),
        });
      },
    },
    templates: [{ id: "typescript-node", language: "typescript" }],
  });
  if (created.status !== "created") throw new Error(created.code);
  return created.evidence;
}

function dataRecord(value: unknown): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("authority input was not an object");
  }
  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error("authority input used a symbol");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("authority input used an accessor");
    }
    result.set(key, descriptor.value);
  }
  return result;
}
