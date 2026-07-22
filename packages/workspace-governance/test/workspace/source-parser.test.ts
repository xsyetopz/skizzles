// biome-ignore-all lint/security/noSecrets: Embedded source-parser fixtures exercise temporary-path handling, not secret material.
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
  it("extracts path and types directives while excluding compiler libraries", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-directive-imports-"));
    roots.push(root);
    const path = join(root, "index.ts");
    const source = [
      '/// <reference path="types.ts" />',
      '/// <reference path="../shared.ts" />',
      '/// <reference types="undeclared-transitive" />',
      '/// <reference lib="dom" />',
      "export {};",
      "",
    ].join("\n");
    await writeFile(path, source);

    expect(
      await parseSourceDependencies([sourceDocument(path, source)]),
    ).toEqual([
      {
        path,
        specifiers: ["../shared.ts", "./types.ts", "undeclared-transitive"],
      },
    ]);
  });

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

  it("extracts temporary ownership through aliases, destructuring, and namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-temporary-imports-"));
    roots.push(root);
    const path = join(root, "temporary.ts");
    const source = [
      'import { mkdtemp as allocate } from "node:fs/promises";',
      'import * as filesystem from "node:fs";',
      'import * as operatingSystem from "node:os";',
      "const { mkdtemp: destructured } = filesystem;",
      "void allocate;",
      "void destructured;",
      "void filesystem.mkdtempSync;",
      "void operatingSystem.tmpdir;",
      'export const posixRoot = "/tmp/skizzles-run";',
      "export const windowsRoot = `C:\\\\Temp\\\\skizzles-run`;",
      "",
    ].join("\n");
    await writeFile(path, source);

    expect(
      await parseSourceDependencies([sourceDocument(path, source)]),
    ).toEqual([
      {
        path,
        specifiers: ["node:fs", "node:fs/promises", "node:os"],
        temporaryOwnership: [
          { kind: "hard-coded-host-temp" },
          { kind: "mkdtemp" },
          { kind: "mkdtempSync" },
          { kind: "tmpdir" },
        ],
      },
    ]);
  });

  it("ignores temporary words in comments, diagnostics, and unrelated APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-temporary-text-"));
    roots.push(root);
    const path = join(root, "text.ts");
    const source = [
      "// mkdtemp(), tmpdir(), and /tmp/example are policy documentation.",
      'const diagnostic = "do not create /tmp/example with mkdtemp or tmpdir";',
      "const local = { mkdtemp: () => undefined, tmpdir: () => undefined };",
      'import type { mkdtemp as MkdtempType } from "node:fs/promises";',
      'import type * as TypeFilesystem from "node:fs";',
      "type ImportedType = typeof MkdtempType;",
      "type NamespaceType = typeof TypeFilesystem.mkdtempSync;",
      "local.mkdtemp();",
      "local.tmpdir();",
      "void diagnostic;",
      "",
    ].join("\n");
    await writeFile(path, source);

    expect(
      await parseSourceDependencies([sourceDocument(path, source)]),
    ).toEqual([{ path, specifiers: ["node:fs", "node:fs/promises"] }]);
  });

  it("extracts ambient, re-exported, chained, and nested disposal authority", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "skizzles-temporary-capabilities-"),
    );
    roots.push(root);
    const path = join(root, "capabilities.ts");
    const source = [
      'import filesystem, { promises as asyncFilesystem, rmSync } from "node:fs";',
      'export { mkdtemp as allocate } from "node:fs/promises";',
      "void filesystem.promises.mkdtemp;",
      "void asyncFilesystem.mkdtemp;",
      'const required = require("node:fs");',
      "void required.mkdtempSync;",
      'const dynamic = await import("node:os");',
      "void dynamic.tmpdir;",
      "void process.env.TMPDIR;",

      "const preview = workspace.path(`preview-${crypto.randomUUID()}`);",
      "rmSync(preview, { recursive: true, force: true });",
      "export const interpolated = `/tmp/run-${crypto.randomUUID()}`;",
      "",
    ].join("\n");
    await writeFile(path, source);

    expect(
      (await parseSourceDependencies([sourceDocument(path, source)]))[0]
        ?.temporaryOwnership,
    ).toEqual([
      { kind: "ambient-temp-env" },
      { kind: "hard-coded-host-temp" },
      { kind: "mkdtemp" },
      { kind: "mkdtempSync" },
      { kind: "nested-recursive-disposal" },
      { kind: "tmpdir" },
    ]);
  });

  it("does not attribute shadowed namespace or type-query references", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-temporary-shadow-"));
    roots.push(root);
    const path = join(root, "shadow.ts");
    const source = [
      'import * as filesystem from "node:fs";',
      "type Method = typeof filesystem.mkdtempSync;",
      "function inspect(filesystem: { mkdtempSync: () => void }) {",
      "  filesystem.mkdtempSync();",
      "}",
      "void inspect;",
      "",
    ].join("\n");
    await writeFile(path, source);

    expect(
      await parseSourceDependencies([sourceDocument(path, source)]),
    ).toEqual([{ path, specifiers: ["node:fs"] }]);
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
