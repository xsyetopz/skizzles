// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { describe, expect, it } from "bun:test";
import { digestText } from "../src/digest.ts";
import {
  buildLocalTypeScriptSymbolIndex,
  type LocalTypeScriptSymbolIndex,
  type SymbolIndexBuildResult,
  type SymbolIndexCaptureRequest,
  type TypeScriptSymbolIndexAuthorityPort,
  verifyImport,
} from "../src/typescript/symbols.ts";

const request = Object.freeze({
  repositoryId: "repository-1",
  rootIdentity: "root-1",
  treeDigest: digestText("tree"),
  configDigest: digestText("config"),
});

describe("local TypeScript symbol index", () => {
  it("parses real sources and returns a frozen deterministic advisory index", async () => {
    const authority = captureAuthority(
      capture(
        [
          document(
            "src/z.ts",
            'export { User } from "./user.ts";\nexport type Zed = string;\n',
          ),
          document(
            "src/user.ts",
            'import type { External } from "@scope/contracts";\nexport interface User { id: string }\nexport function load(): User { return { id: "x" }; }\n',
          ),
        ],
        ["@scope/contracts"],
      ),
    );

    const result = await buildLocalTypeScriptSymbolIndex(authority, request);

    expect(result.status).toBe("indexed");
    if (result.status !== "indexed") return;
    expect(result.index.advisory).toBe(true);
    expect(Object.isFrozen(result.index)).toBe(true);
    expect(Object.isFrozen(result.index.declarations)).toBe(true);
    expect(
      result.index.declarations.map(({ kind, name, path }) => ({
        kind,
        name,
        path,
      })),
    ).toEqual([
      { kind: "function", name: "load", path: "src/user.ts" },
      { kind: "interface", name: "User", path: "src/user.ts" },
      { kind: "type", name: "Zed", path: "src/z.ts" },
    ]);
    expect(
      result.index.modules.map(({ kind, path, specifier }) => ({
        kind,
        path,
        specifier,
      })),
    ).toEqual([
      { kind: "import", path: "src/user.ts", specifier: "@scope/contracts" },
      { kind: "export", path: "src/z.ts", specifier: "./user.ts" },
    ]);
    expect(
      verifyImport(result.index, {
        fromPath: "src/z.ts",
        specifier: "./user.ts",
      }),
    ).toEqual({
      status: "verified",
      advisory: true,
      result: "found",
      matchedBy: "source",
    });
    expect(
      verifyImport(result.index, {
        fromPath: "src/user.ts",
        specifier: "@scope/contracts/models",
      }),
    ).toEqual({
      status: "verified",
      advisory: true,
      result: "found",
      matchedBy: "package",
    });
  });

  it("sorts authority order out of the index digest", async () => {
    const left = await buildLocalTypeScriptSymbolIndex(
      captureAuthority(
        capture(
          [
            document("b.ts", "export class B {}"),
            document("a.ts", "export class A {}"),
          ],
          ["z", "a"],
        ),
      ),
      request,
    );
    const right = await buildLocalTypeScriptSymbolIndex(
      captureAuthority(
        capture(
          [
            document("a.ts", "export class A {}"),
            document("b.ts", "export class B {}"),
          ],
          ["a", "z"],
        ),
      ),
      request,
    );
    expect(indexOf(left).indexDigest).toBe(indexOf(right).indexDigest);
  });

  it("accepts a complete source capture larger than the repository's former 256-file ceiling", async () => {
    const documents = Array.from({ length: 257 }, (_, index) =>
      document(
        `src/file-${index}.ts`,
        `export interface Symbol${index} { value: string }`,
      ),
    );
    const result = await buildLocalTypeScriptSymbolIndex(
      captureAuthority(capture(documents, [])),
      request,
    );
    expect(result.status).toBe("indexed");
    if (result.status === "indexed") {
      expect(result.index.sourcePaths).toHaveLength(257);
      expect(result.index.declarations).toHaveLength(257);
    }
  }, 120_000);

  it("rejects incomplete and stale authority captures", async () => {
    const incomplete = frozenCapture({
      ...request,
      complete: false,
      packages: Object.freeze([]),
      documents: Object.freeze([document("a.ts", "export class A {}")]),
    });
    expect(
      await buildLocalTypeScriptSymbolIndex(
        captureAuthority(incomplete),
        request,
      ),
    ).toEqual({
      status: "rejected",
      code: "INDEX_CAPTURE_INCOMPLETE",
    });

    const stale = capture([document("a.ts", "export class A {}")], [], {
      treeDigest: digestText("other-tree"),
    });
    expect(
      await buildLocalTypeScriptSymbolIndex(captureAuthority(stale), request),
    ).toEqual({
      status: "rejected",
      code: "INDEX_BINDING_STALE",
    });
  });

  it("rejects digest drift, duplicate paths, unsupported files, and syntax errors", async () => {
    const drifted = Object.freeze({
      path: "a.ts",
      text: "export class A {}",
      digest: digestText("different"),
    });
    const cases: readonly [
      unknown,
      Extract<SymbolIndexBuildResult, { status: "rejected" }>["code"],
    ][] = [
      [captureRaw([drifted]), "INDEX_CAPTURE_INVALID"],
      [
        captureRaw([
          document("a.ts", "export class A {}"),
          document("a.ts", "export class B {}"),
        ]),
        "INDEX_CAPTURE_INVALID",
      ],
      [
        captureRaw([document("a.py", "export class A {}")]),
        "INDEX_CAPTURE_INVALID",
      ],
      [
        captureRaw([document("a.ts", "export class {")]),
        "INDEX_SYNTAX_REJECTED",
      ],
    ];
    for (const [captured, code] of cases) {
      expect(
        await buildLocalTypeScriptSymbolIndex(
          captureAuthority(captured),
          request,
        ),
      ).toEqual({
        status: "rejected",
        code,
      });
    }
  });

  it("rejects mutable, accessor, and proxy authority data", async () => {
    const mutable = {
      ...request,
      complete: true,
      packages: Object.freeze([]),
      documents: Object.freeze([document("a.ts", "export class A {}")]),
    };
    const accessor = Object.freeze(
      Object.defineProperty(
        {
          ...request,
          complete: true,
          packages: Object.freeze([]),
          documents: Object.freeze([document("a.ts", "export class A {}")]),
        },
        "treeDigest",
        { enumerable: true, get: () => request.treeDigest },
      ),
    );
    const proxy = new Proxy(
      captureRaw([document("a.ts", "export class A {}")]),
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    for (const captured of [mutable, accessor, proxy]) {
      expect(
        await buildLocalTypeScriptSymbolIndex(
          captureAuthority(captured),
          request,
        ),
      ).toEqual({
        status: "rejected",
        code: "INDEX_CAPTURE_INVALID",
      });
    }
  });

  it("rejects forged indexes and malformed import queries", async () => {
    const built = await buildLocalTypeScriptSymbolIndex(
      captureAuthority(capture([document("a.ts", "export class A {}")], [])),
      request,
    );
    const index = indexOf(built);
    expect(
      verifyImport(
        { ...index },
        {
          fromPath: "a.ts",
          specifier: "./a",
        },
      ),
    ).toEqual({
      status: "rejected",
      code: "INVALID_INDEX",
    });
    expect(
      verifyImport(
        index,
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("trap");
            },
          },
        ),
      ),
    ).toEqual({
      status: "rejected",
      code: "INVALID_IMPORT_QUERY",
    });
  });
});

function document(path: string, text: string) {
  return Object.freeze({ path, text, digest: digestText(text) });
}

function capture(
  documents: readonly ReturnType<typeof document>[],
  packages: readonly string[],
  overrides: Partial<SymbolIndexCaptureRequest> = {},
) {
  return frozenCapture({
    ...request,
    ...overrides,
    complete: true,
    packages: Object.freeze([...packages]),
    documents: Object.freeze([...documents]),
  });
}

function captureRaw(documents: readonly ReturnType<typeof document>[]) {
  return frozenCapture({
    ...request,
    complete: true,
    packages: Object.freeze([]),
    documents: Object.freeze([...documents]),
  });
}

function frozenCapture<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function captureAuthority(value: unknown): TypeScriptSymbolIndexAuthorityPort {
  return { capture: () => value };
}

function indexOf(
  result: Awaited<ReturnType<typeof buildLocalTypeScriptSymbolIndex>>,
): LocalTypeScriptSymbolIndex {
  if (result.status !== "indexed")
    throw new Error(`expected index, received ${result.code}`);
  return result.index;
}
