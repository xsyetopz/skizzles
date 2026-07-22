// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import type {
  ParsedTypeScriptSource,
  TypeScriptDeclaration,
  TypeScriptNodeOperation,
} from "../src/typescript/contract.ts";
import {
  editTypeScriptDeclarations,
  listTypeScriptDeclarations,
} from "../src/typescript/editor.ts";
import { parseTypeScriptSource } from "../src/typescript/parser.ts";

const baseline = [
  "export function alpha(): number { return 1; }",
  "export interface Shape { readonly value: number; }",
  "export type Label = string;",
  "export class Box { readonly value = 1; }",
  "export enum State { Ready }",
  "",
].join("\n");

describe("TypeScript 7 declaration editing", () => {
  it("catalogs declarations and derives replace, insert, and delete candidates", async () => {
    const parsed = await parseAccepted(baseline);
    const declarations = listTypeScriptDeclarations(parsed);
    expect(declarations.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "function", name: "alpha" },
      { kind: "interface", name: "Shape" },
      { kind: "type", name: "Label" },
      { kind: "class", name: "Box" },
      { kind: "enum", name: "State" },
    ]);

    const result = await editTypeScriptDeclarations({
      parsed,
      objective: "behavioral",
      operations: [
        {
          kind: "replace",
          selector: selector(declarations, "function", "alpha"),
          source: "export function alpha(): number { return 2; }",
        },
        {
          kind: "insert-before",
          selector: selector(declarations, "interface", "Shape"),
          source: "export enum Mode { Strict }\n",
        },
        {
          kind: "delete",
          selector: selector(declarations, "type", "Label"),
        },
      ],
      parseCandidate,
    });

    expect(result.status).toBe("edited");
    if (result.status !== "edited") {
      throw new Error("valid declaration edits were rejected");
    }
    const candidate = new TextDecoder().decode(
      Uint8Array.from(result.receipt.candidateBytes),
    );
    expect(candidate).toContain("return 2");
    expect(candidate).toContain("enum Mode");
    expect(candidate).not.toContain("type Label");
    expect(result.receipt.changedNodeDigests).toHaveLength(3);
    expect(result.receipt.candidateDigest).not.toBe(
      result.receipt.baselineDigest,
    );
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(result.receipt.candidateBytes)).toBe(true);
    expect(Reflect.set(result.receipt.candidateBytes, "0", 0)).toBe(false);
  });

  it("rejects drifted declaration identities before invoking the parser", async () => {
    const parsed = await parseAccepted(baseline);
    let parserCalls = 0;
    const result = await editTypeScriptDeclarations({
      parsed,
      objective: "behavioral",
      operations: [
        {
          kind: "delete",
          selector: {
            kind: "function",
            name: "alpha",
            expectedNodeDigest: `sha256:${"0".repeat(64)}`,
          },
        },
      ],
      async parseCandidate(text) {
        parserCalls += 1;
        return parseCandidate(text);
      },
    });
    expect(result).toEqual({ status: "rejected", code: "NODE_DRIFTED" });
    expect(parserCalls).toBe(0);
  });

  it("reparses after every operation and rejects an invalid intermediate AST", async () => {
    const parsed = await parseAccepted(baseline);
    const declarations = listTypeScriptDeclarations(parsed);
    let parserCalls = 0;
    const operations: readonly TypeScriptNodeOperation[] = [
      {
        kind: "replace",
        selector: selector(declarations, "function", "alpha"),
        source: "export function alpha(): number { return 2; }",
      },
      {
        kind: "replace",
        selector: selector(declarations, "interface", "Shape"),
        source: "export interface Shape {",
      },
    ];
    const result = await editTypeScriptDeclarations({
      parsed,
      objective: "behavioral",
      operations,
      async parseCandidate(text) {
        parserCalls += 1;
        return parseCandidate(text);
      },
    });
    expect(result).toEqual({ status: "rejected", code: "INVALID_EDIT" });
    expect(parserCalls).toBe(2);
  });

  it("rejects formatting-only edits for a behavioral objective", async () => {
    const parsed = await parseAccepted(baseline);
    const declarations = listTypeScriptDeclarations(parsed);
    const result = await editTypeScriptDeclarations({
      parsed,
      objective: "behavioral",
      operations: [
        {
          kind: "replace",
          selector: selector(declarations, "function", "alpha"),
          source: "export function alpha( ): number {\n  return 1;\n}",
        },
      ],
      parseCandidate,
    });
    expect(result).toEqual({ status: "rejected", code: "SEMANTIC_NOOP" });
  });

  it("rejects behavioral edits for a format-only objective", async () => {
    const parsed = await parseAccepted(baseline);
    const declarations = listTypeScriptDeclarations(parsed);
    const result = await editTypeScriptDeclarations({
      parsed,
      objective: "format-only",
      operations: [
        {
          kind: "replace",
          selector: selector(declarations, "function", "alpha"),
          source: "export function alpha(): number { return 2; }",
        },
      ],
      parseCandidate,
    });
    expect(result).toEqual({ status: "rejected", code: "SEMANTIC_DRIFT" });
  });

  it("returns bounded syntax evidence and contains hostile parser inputs", async () => {
    await expect(
      parseTypeScriptSource({ targetPath: "src/empty.ts", sourceText: "" }),
    ).resolves.toMatchObject({ status: "parsed" });

    const syntax = await parseTypeScriptSource({
      targetPath: "src/broken.ts",
      sourceText: "export function broken(",
    });
    expect(syntax).toMatchObject({
      status: "rejected",
      code: "SYNTAX_REJECTED",
    });
    if (syntax.status !== "rejected") {
      throw new Error("invalid source was parsed");
    }
    expect(syntax.diagnostics.length).toBeGreaterThan(0);
    expect(Object.isFrozen(syntax.diagnostics)).toBe(true);

    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile parser input");
        },
      },
    );
    await expect(parseTypeScriptSource(hostile)).resolves.toEqual({
      status: "rejected",
      code: "PARSER_REJECTED",
      diagnostics: [],
    });
    await expect(
      parseTypeScriptSource({
        targetPath: "../outside.ts",
        sourceText: "export {};",
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "INVALID_PARSE_INPUT",
      diagnostics: [],
    });

    await expect(
      parseTypeScriptSource({
        targetPath: "src/not-typescript.py",
        sourceText: "export {};",
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "INVALID_PARSE_INPUT",
      diagnostics: [],
    });

    let getterCalls = 0;
    const accessor = Object.defineProperties(
      {},
      {
        targetPath: {
          enumerable: true,
          get(): string {
            getterCalls += 1;
            return "src/accessor.ts";
          },
        },
        sourceText: { enumerable: true, value: "export {};" },
      },
    );
    await expect(parseTypeScriptSource(accessor)).resolves.toEqual({
      status: "rejected",
      code: "INVALID_PARSE_INPUT",
      diagnostics: [],
    });
    expect(getterCalls).toBe(0);

    await expect(
      parseTypeScriptSource({
        targetPath: "src/symbol.ts",
        sourceText: "export {};",
        [Symbol("extra")]: true,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "INVALID_PARSE_INPUT",
      diagnostics: [],
    });
  });
});

async function parseAccepted(
  sourceText: string,
): Promise<ParsedTypeScriptSource> {
  const result = await parseTypeScriptSource({
    targetPath: "src/example.ts",
    sourceText,
  });
  if (result.status !== "parsed") {
    throw new Error(`TypeScript parser rejected valid source: ${result.code}`);
  }
  return result.parsed;
}

async function parseCandidate(text: string): Promise<ParsedTypeScriptSource> {
  const result = await parseTypeScriptSource({
    targetPath: "src/example.ts",
    sourceText: text,
  });
  if (result.status !== "parsed") {
    throw new Error(`candidate syntax rejected: ${result.code}`);
  }
  return result.parsed;
}

function selector(
  declarations: readonly TypeScriptDeclaration[],
  kind: TypeScriptDeclaration["kind"],
  name: string,
): TypeScriptNodeOperation["selector"] {
  const declaration = declarations.find(
    (candidate) => candidate.kind === kind && candidate.name === name,
  );
  if (declaration === undefined) {
    throw new Error(`missing declaration ${kind}:${name}`);
  }
  return {
    kind,
    name,
    expectedNodeDigest: declaration.nodeDigest,
  };
}
