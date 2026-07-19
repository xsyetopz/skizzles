// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CurrentSourceReader,
  parseSourceDependencies,
  type SourceDependencyBackend,
  type SourceDocument,
} from "../../src/workspace/source/parser.ts";

const roots: string[] = [];
const documents: readonly SourceDocument[] = [
  sourceDocument("/virtual/b.ts", 'void import("dynamic");'),
  sourceDocument("/virtual/a.ts", "export {};"),
];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("source parser lifecycle", () => {
  it("preserves dynamic imports after every hashbang line terminator", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-hashbang-imports-"));
    roots.push(root);
    const cases = [
      { name: "lf", terminator: "\n" },
      { name: "crlf", terminator: "\r\n" },
      { name: "cr", terminator: "\r" },
      { name: "line-separator", terminator: "\u2028" },
      { name: "paragraph-separator", terminator: "\u2029" },
    ];
    const hashbangDocuments = await Promise.all(
      cases.map(async ({ name, terminator }, index) => {
        const path = join(root, `${name}.ts`);
        const source = `#!bun${terminator}void import("hashbang-${index}");`;
        await writeFile(path, source);
        return sourceDocument(path, source);
      }),
    );
    const unterminatedPath = join(root, "unterminated.ts");
    await writeFile(unterminatedPath, "#!bun");
    hashbangDocuments.push(sourceDocument(unterminatedPath, "#!bun"));

    expect(await parseSourceDependencies(hashbangDocuments)).toEqual([
      ...cases.map((_, index) => ({
        path: hashbangDocuments[index]?.path ?? "",
        specifiers: [`hashbang-${index}`],
      })),
      { path: unterminatedPath, specifiers: [] },
    ]);
  });

  it("deduplicates and sorts the Bun and AST dependency union", async () => {
    const backend: SourceDependencyBackend = {
      parse: (paths) =>
        Promise.resolve([
          {
            path: paths[0] ?? "",
            specifiers: ["z-static", "dynamic", "a-static", "a-static"],
          },
          { path: paths[1] ?? "", specifiers: [] },
        ]),
      close: () => Promise.resolve(),
    };

    expect(
      await parseSourceDependencies(
        documents,
        () => backend,
        originalSourceReader(documents),
      ),
    ).toEqual([
      {
        path: "/virtual/b.ts",
        specifiers: ["a-static", "dynamic", "z-static"],
      },
      { path: "/virtual/a.ts", specifiers: [] },
    ]);
  });

  it("fails closed when A, TypeScript, and B are not byte-consistent", async () => {
    const changingDocuments: readonly SourceDocument[] = [
      sourceDocument("/virtual/stale.ts", "export {};"),
      sourceDocument("/virtual/mixed.ts", 'void import("runtime-from-a");'),
      sourceDocument("/virtual/unreadable.ts", "export {};"),
    ];
    const backend: SourceDependencyBackend = {
      parse: (paths) =>
        Promise.resolve(
          paths.map((path) => {
            const specifiers: string[] = [];
            if (path.endsWith("mixed.ts")) {
              specifiers.push("static-from-typescript");
            }
            return { path, specifiers };
          }),
        ),
      close: () => Promise.resolve(),
    };
    const readChangedSource: CurrentSourceReader = (path) => {
      if (path.endsWith("stale.ts")) {
        return Promise.resolve(encodeSource('void import("disk-only");'));
      }
      if (path.endsWith("mixed.ts")) {
        return Promise.resolve(
          encodeSource('export type { Value } from "static-from-typescript";'),
        );
      }
      return Promise.reject(new Error("unreadable"));
    };

    expect(
      await parseSourceDependencies(
        changingDocuments,
        () => backend,
        readChangedSource,
      ),
    ).toEqual([
      {
        path: "/virtual/stale.ts",
        error: "source changed during TypeScript parsing",
      },
      {
        path: "/virtual/mixed.ts",
        error: "source changed during TypeScript parsing",
      },
      {
        path: "/virtual/unreadable.ts",
        error: "source could not be reread after TypeScript parsing",
      },
    ]);
  });

  it("fails every file closed on backend and cleanup failures", async () => {
    let backendClosed = false;
    const backendFailure: SourceDependencyBackend = {
      parse: () => Promise.reject(new Error("backend unavailable")),
      close: () => {
        backendClosed = true;
        return Promise.resolve();
      },
    };
    const backendResults = await parseSourceDependencies(
      documents,
      () => backendFailure,
    );
    expect(backendClosed).toBe(true);
    expect(backendResults.map(({ error }) => error)).toEqual([
      "backend unavailable",
      "backend unavailable",
    ]);

    const cleanupFailure: SourceDependencyBackend = {
      parse: (paths) =>
        Promise.resolve(paths.map((path) => ({ path, specifiers: [] }))),
      close: () => Promise.reject(new Error("cleanup unavailable")),
    };
    const cleanupResults = await parseSourceDependencies(
      documents,
      () => cleanupFailure,
    );
    expect(cleanupResults.map(({ error }) => error)).toEqual([
      "cleanup unavailable",
      "cleanup unavailable",
    ]);
  });
});

function sourceDocument(path: string, source: string): SourceDocument {
  return { path, source: encodeSource(source), loader: "ts" };
}

function encodeSource(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function originalSourceReader(
  sourceDocuments: readonly SourceDocument[],
): CurrentSourceReader {
  return (path) => {
    const document = sourceDocuments.find(
      (candidate) => candidate.path === path,
    );
    if (document === undefined) {
      return Promise.reject(new Error("missing virtual source"));
    }
    return Promise.resolve(document.source);
  };
}
