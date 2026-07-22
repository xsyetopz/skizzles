// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";

import type { CandidateManifestEntry } from "../src/index.ts";
import {
  createCandidateManifest,
  isCandidateManifest,
  parseCandidateManifest,
} from "../src/index.ts";

const sha256HexLength = 64;
const maximumPathLength = 4096;
const digestA = `sha256:${"a".repeat(sha256HexLength)}` as const;
const digestB = `sha256:${"b".repeat(sha256HexLength)}` as const;

function frozenManifest(value: {
  readonly [key: string]: unknown;
  readonly schema?: unknown;
  readonly domain?: unknown;
  readonly version?: unknown;
  readonly entries?: unknown;
  readonly manifestDigest?: unknown;
}): object {
  return Object.freeze(value);
}

describe("candidate manifest canonicalization", () => {
  it("creates a deterministic digest from sorted immutable canonical entries", () => {
    const first = createCandidateManifest([
      { path: "zeta.ts", operation: "write", contentDigest: digestA },
      { path: "alpha.ts", operation: "delete", contentDigest: null },
    ]);
    const second = createCandidateManifest([
      { path: "alpha.ts", operation: "delete", contentDigest: null },
      { path: "zeta.ts", operation: "write", contentDigest: digestA },
    ]);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0])).toBe(true);
    expect(parseCandidateManifest(first)).toBe(first);
  });
});

describe("candidate manifest semantic differences", () => {
  it("keeps deletes, paths, and omissions semantically distinct", () => {
    const emptyWrite = createCandidateManifest([
      { path: "source.ts", operation: "write", contentDigest: digestA },
    ]);
    const deleted = createCandidateManifest([
      { path: "source.ts", operation: "delete", contentDigest: null },
    ]);
    const renamed = createCandidateManifest([
      { path: "renamed.ts", operation: "write", contentDigest: digestA },
    ]);
    const omitted = createCandidateManifest([
      { path: "unrelated.ts", operation: "write", contentDigest: digestA },
    ]);
    expect(emptyWrite.manifestDigest).not.toBe(deleted.manifestDigest);
    expect(emptyWrite.manifestDigest).not.toBe(renamed.manifestDigest);
    expect(emptyWrite.manifestDigest).not.toBe(omitted.manifestDigest);
  });
});

describe("candidate manifest boundary parsing", () => {
  it("rejects mutable, reordered, duplicate, omitted, and extra boundary data", () => {
    const canonical = createCandidateManifest([
      { path: "alpha.ts", operation: "write", contentDigest: digestA },
      { path: "beta.ts", operation: "write", contentDigest: digestB },
    ]);
    const mutable = {
      ...canonical,
      entries: canonical.entries.map((entry) => ({ ...entry })),
    };
    expect(parseCandidateManifest(mutable)).toBeUndefined();

    const reordered = frozenManifest({
      ...canonical,
      entries: Object.freeze([...canonical.entries].reverse()),
    });
    expect(parseCandidateManifest(reordered)).toBeUndefined();

    const duplicate = frozenManifest({
      ...canonical,
      entries: Object.freeze([
        canonical.entries[0],
        Object.freeze({
          path: "alpha.ts",
          operation: "write",
          contentDigest: digestB,
        }),
      ]),
    });
    expect(parseCandidateManifest(duplicate)).toBeUndefined();

    const omitted = frozenManifest({
      schema: canonical.schema,
      domain: canonical.domain,
      version: canonical.version,
      entries: canonical.entries,
    });
    expect(parseCandidateManifest(omitted)).toBeUndefined();

    const extra = frozenManifest({ ...canonical, extra: true });
    expect(parseCandidateManifest(extra)).toBeUndefined();
  });

  it("rejects proxies and accessor-based forgeries", () => {
    const canonical = createCandidateManifest([
      { path: "alpha.ts", operation: "write", contentDigest: digestA },
    ]);
    const proxy = new Proxy(canonical, {});
    expect(isCandidateManifest(proxy)).toBe(false);
    const accessor = Object.freeze({
      schema: canonical.schema,
      domain: canonical.domain,
      version: canonical.version,
      entries: canonical.entries,
      get manifestDigest(): string {
        return canonical.manifestDigest;
      },
    });
    expect(parseCandidateManifest(accessor)).toBeUndefined();
  });
});

describe("candidate manifest safe paths", () => {
  it("rejects Unicode, case, host-path, and traversal aliases", () => {
    for (const path of [
      "./source.ts",
      "source//file.ts",
      "source/../file.ts",
      "/source.ts",
      "C:\\source.ts",
      "source\\file.ts",
      "e\u0301.ts",
    ]) {
      expect(() =>
        createCandidateManifest([
          { path, operation: "write", contentDigest: digestA },
        ]),
      ).toThrow();
    }
    expect(() =>
      createCandidateManifest([
        { path: "source.ts", operation: "write", contentDigest: digestA },
        { path: "Source.ts", operation: "write", contentDigest: digestB },
      ]),
    ).toThrow();
  });
});

describe("candidate manifest construction boundary", () => {
  it("rejects empty, oversized, proxied, and accessor-backed entries", () => {
    expect(() => createCandidateManifest([])).toThrow();
    const tooLongPath = `a${"b".repeat(maximumPathLength)}.ts`;
    expect(() =>
      createCandidateManifest([
        { path: tooLongPath, operation: "write", contentDigest: digestA },
      ]),
    ).toThrow();
    const entryProxy = new Proxy(
      { path: "source.ts", operation: "write", contentDigest: digestA },
      {},
    );
    expect(() =>
      createCandidateManifest([entryProxy as CandidateManifestEntry]),
    ).toThrow();
    let accessed = false;
    const accessorEntry = Object.defineProperty({}, "path", {
      get(): string {
        accessed = true;
        return "source.ts";
      },
      enumerable: true,
    });
    Object.defineProperties(accessorEntry, {
      operation: { value: "write", enumerable: true },
      contentDigest: { value: digestA, enumerable: true },
    });
    expect(() => createCandidateManifest([accessorEntry as never])).toThrow();
    expect(accessed).toBe(false);
  });
});

describe("candidate manifest operation consistency", () => {
  it("rejects invalid operation and content-digest combinations", () => {
    expect(() =>
      createCandidateManifest([
        { path: "source.ts", operation: "delete", contentDigest: digestA },
      ]),
    ).toThrow();
    expect(() =>
      createCandidateManifest([
        { path: "source.ts", operation: "write", contentDigest: null },
      ]),
    ).toThrow();
  });
});
