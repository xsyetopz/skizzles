// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  FormatterAuthorityPort,
  TypeScriptSymbolIndexAuthorityPort,
} from "../../src/index.ts";
import {
  createLiteralRegistry,
  createSourceEngineering,
  createSourceEvidence,
  createTypeScriptAstLanguageAdapter,
  createTypeScriptCompilerAuthority,
  registerTypeScriptFormatterProfile,
} from "../../src/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("language adapter public workflows", () => {
  it.each([
    {
      language: "javascript" as const,
      path: "test/value.test.js",
      baseline:
        "export function value() { const answer = 1; return answer; }\n",
      replacement:
        "export function value() { const answer = 2; return answer; }",
    },
    {
      language: "tsx" as const,
      path: "test/view.test.tsx",
      baseline:
        'export {};\ndeclare global { namespace JSX { interface IntrinsicElements { section: { "data-label"?: string; children?: unknown } } } }\nexport function View() { const label = "old"; return <section data-label={label}>{label}</section>; }\n',
      replacement:
        'export function View() { const label = "new"; return <section data-label={label}>{label}</section>; }',
    },
  ])(
    "describes, edits, formats twice, strictly compiles, and verifies $language",
    async ({ language, path, baseline, replacement }) => {
      const root = mkdtempSync(join(tmpdir(), "skizzles-language-workflow-"));
      roots.push(root);
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), baseline);
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            useUnknownInCatchVariables: true,
            allowJs: language === "javascript",
            checkJs: language === "javascript",
            jsx: language === "tsx" ? "preserve" : undefined,
            noEmit: true,
          },
          include: [path],
        }),
      );
      const requestDigest = digest("request");
      const treeDigest = digest("tree");
      const configDigest = digest("config");
      const repository = Object.freeze({
        id: "language-repo",
        rootIdentity: "root",
        treeDigest,
        configDigest,
      });
      const sourceEvidenceResult = createSourceEvidence(
        Object.freeze({
          sourceCaptureAuthority: {
            capture: (input: unknown) =>
              Object.freeze({
                ...recordOf(input),
                baselineDigest: digest(baseline),
                baselineBytes: Object.freeze([
                  ...new TextEncoder().encode(baseline),
                ]),
              }),
          },
          templateAuthority: {
            materialize: (input: unknown) => {
              const record = recordOf(input);
              const { nodeSource: _nodeSource, ...bindings } = record;
              return Object.freeze({
                ...bindings,
                templateDigest: digest("template"),
                tool: "template-tool",
                toolVersion: "1.0.0",
                contentDigest: record["nodeSourceDigest"],
                schemaDigest: digest("complete declaration"),
              });
            },
          },
          templates: Object.freeze([{ id: "declaration", language }]),
        }),
      );
      if (sourceEvidenceResult.status !== "created")
        throw new Error(sourceEvidenceResult.code);
      const formatterCalls: number[] = [];
      const formatterAuthority: FormatterAuthorityPort = Object.freeze({
        format: (request: Parameters<FormatterAuthorityPort["format"]>[0]) => {
          formatterCalls.push(request.pass);
          const { sourceText, ...bindings } = request;
          return Object.freeze({
            ...bindings,
            formattedText: sourceText,
          });
        },
      });
      const formatterResult = registerTypeScriptFormatterProfile(
        Object.freeze({
          profileId: "formatter",
          language,
          tool: "formatter-tool",
          version: "1.0.0",
          configDigest: digest("formatter-config"),
          authority: formatterAuthority,
        }),
      );
      if (formatterResult.status !== "registered")
        throw new Error(formatterResult.code);
      const compilerResult = createTypeScriptCompilerAuthority(
        Object.freeze({
          repository: Object.freeze({
            repositoryId: repository.id,
            rootIdentity: repository.rootIdentity,
            treeDigest,
            configDigest,
            rootPath: root,
            configPath: "tsconfig.json",
          }),
          profile: Object.freeze({
            profileId: "strict",
            toolId: "typescript",
            toolVersion: "7.0.2",
          }),
        }),
      );
      if (compilerResult.status !== "created")
        throw new Error(compilerResult.code);
      const indexAuthority: TypeScriptSymbolIndexAuthorityPort = Object.freeze({
        capture: (
          input: Parameters<TypeScriptSymbolIndexAuthorityPort["capture"]>[0],
        ) =>
          Object.freeze({
            repositoryId: input.repositoryId,
            rootIdentity: input.rootIdentity,
            treeDigest: input.treeDigest,
            configDigest: input.configDigest,
            complete: true,
            packages: Object.freeze([]),
            documents: Object.freeze([
              Object.freeze({
                path,
                text: baseline,
                digest: digest(baseline),
              }),
            ]),
          }),
      });
      const adapterResult = createTypeScriptAstLanguageAdapter(
        Object.freeze({
          language,
          formatterProfiles: Object.freeze([formatterResult.profile]),
          compilerAuthority: compilerResult.authority,
          compilerProfile: Object.freeze({
            profileId: "strict",
            toolId: "typescript",
            toolVersion: "7.0.2",
          }),
          symbolIndexAuthority: indexAuthority,
        }),
      );
      if (adapterResult.status !== "created")
        throw new Error(adapterResult.code);
      expect(adapterResult.adapter.supportsPath(path)).toBe(true);
      const directParse = await adapterResult.adapter.parse(
        Object.freeze({ targetPath: path, sourceText: baseline }),
      );
      expect(directParse).toMatchObject({ status: "parsed" });
      const candidateText =
        language === "tsx"
          ? `${baseline.slice(0, baseline.indexOf("export function"))}${replacement}\n`
          : `${replacement}\n`;
      const replacementParse = await adapterResult.adapter.parse(
        Object.freeze({ targetPath: path, sourceText: candidateText }),
      );
      expect(replacementParse).toMatchObject({ status: "parsed" });
      const directFormat = await adapterResult.adapter.formatCandidate(
        Object.freeze({
          candidate: recordOf(replacementParse)["parsed"],
          treeDigest,
          profileId: "formatter",
        }),
      );
      expect(directFormat).toMatchObject({ status: "formatted" });
      formatterCalls.length = 0;
      const semanticDigest = adapterResult.adapter.digestSemantics(
        recordOf(replacementParse)["parsed"],
      );
      if (
        typeof semanticDigest !== "string" ||
        !semanticDigest.startsWith("sha256:")
      ) {
        throw new Error("adapter did not produce a semantic digest");
      }
      const directCompiler = await adapterResult.adapter.validateCandidate(
        Object.freeze({
          requestDigest,
          repositoryId: repository.id,
          rootIdentity: repository.rootIdentity,
          treeDigest,
          configDigest,
          targetPath: path,
          candidateDigest: digest(candidateText),
          semanticDigest,
          targets: Object.freeze([
            Object.freeze({
              path,
              candidateDigest: digest(candidateText),
              semanticDigest,
              candidateBytes: Object.freeze([
                ...new TextEncoder().encode(candidateText),
              ]),
            }),
          ]),
        }),
      );
      expect(directCompiler).toMatchObject({ status: "accepted" });
      const directIndex = await adapterResult.adapter.buildSymbolIndex(
        Object.freeze({
          repositoryId: repository.id,
          rootIdentity: repository.rootIdentity,
          treeDigest,
          configDigest,
        }),
      );
      expect(directIndex).toMatchObject({ status: "indexed" });
      const literal = createLiteralRegistry(
        Object.freeze({
          registryId: "parameters",
          registryPath: "src/parameters.ts",
          exportName: "PARAMETERS",
        }),
      );
      if (literal.status !== "created") throw new Error(literal.code);
      const engineResult = createSourceEngineering(
        Object.freeze({
          sourceEvidence: sourceEvidenceResult.evidence,
          languageAdapters: Object.freeze([adapterResult.adapter]),
          literalRegistry: literal.registry,
          templates: Object.freeze([
            Object.freeze({
              templateId: "declaration",
              language,
              schemaText: "complete declaration",
              description: "complete declaration",
              bindings: Object.freeze(["declaration"]),
              tool: "template-tool",
              version: "1.0.0",
            }),
          ]),
        }),
      );
      if (engineResult.status !== "created") throw new Error(engineResult.code);
      const described = await engineResult.sourceEngineering.describe(
        Object.freeze({
          requestDigest,
          repository,
          language,
          objective: "behavioral",
          targets: Object.freeze([Object.freeze({ path })]),
          formatterId: "formatter",
        }),
      );
      expect(described.status).toBe("described");
      if (described.status !== "described") throw new Error(described.code);
      const declaration = described.context.targets[0]?.declarations[0];
      if (declaration === undefined) throw new Error("missing declaration");
      const batch = Object.freeze({
        requestDigest,
        repository,
        language,
        objective: "behavioral",
        targets: Object.freeze([
          Object.freeze({
            path,
            operations: Object.freeze([
              Object.freeze({
                kind: "replace",
                selector: Object.freeze({
                  declarationKind: "function",
                  name: declaration.name,
                  expectedNodeDigest: declaration.nodeDigest,
                }),
                templateId: "declaration",
                nodeSource: replacement,
              }),
            ]),
          }),
        ]),
        formatterId: "formatter",
        faultCases: Object.freeze({
          declarations: Object.freeze([]),
          negativeTests: Object.freeze([]),
        }),
        context: described.receipt,
        contextDigest: described.context.contextDigest,
      });
      const started = engineResult.sourceEngineering.start(batch);
      if (started.status !== "ready") {
        throw new Error(`start failed: ${started.code}`);
      }
      expect(started.status).toBe("ready");
      const edited = await engineResult.sourceEngineering.advance(
        Object.freeze({ cursor: started.cursor }),
      );
      expect(edited.status).toBe("ready");
      if (edited.status !== "ready") throw new Error("edit failed");
      const formatted = await engineResult.sourceEngineering.advance(
        Object.freeze({ cursor: edited.cursor }),
      );
      if (formatted.status !== "ready") {
        throw new Error(
          formatted.status === "rejected"
            ? `format failed: ${formatted.code}`
            : "format unexpectedly prepared the batch",
        );
      }
      const prepared = await engineResult.sourceEngineering.advance(
        Object.freeze({ cursor: formatted.cursor }),
      );
      if (prepared.status !== "prepared") {
        throw new Error(
          prepared.status === "rejected"
            ? `validate failed: ${prepared.code}`
            : "validate returned another cursor",
        );
      }
      expect(prepared.status).toBe("prepared");
      expect(formatterCalls).toEqual([1, 2]);
      expect(
        prepared.receipt.compilerReceipt.receipts[0]?.strictFlags,
      ).toMatchObject({
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        useUnknownInCatchVariables: true,
      });
      expect(prepared.receipt.indexReceipt.status).toBe("indexed");
      const verification = engineResult.sourceEngineering.verify(
        Object.freeze({
          artifacts: prepared.artifacts,
          receipt: prepared.receipt,
        }),
      );
      expect(verification.status).toBe("valid");
    },
  );
});

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("authority input was not a record");
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("authority input used an accessor");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
