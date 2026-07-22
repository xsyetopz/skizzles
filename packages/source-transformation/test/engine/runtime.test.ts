import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  createSourceEngineering,
  isSourceEngineering,
} from "../../src/engine/runtime.ts";
import { createTypeScriptCompilerAuthority } from "../../src/evidence/compiler.ts";
import { createSourceEvidence } from "../../src/evidence/source.ts";
import { createTypeScriptAstLanguageAdapter } from "../../src/language/adapter.ts";
import { createLiteralRegistry } from "../../src/policy/literal/registry.ts";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("source engineering runtime", () => {
  it("rejects malformed configuration without exposing a partial engine", () => {
    expect(createSourceEngineering(undefined)).toEqual({
      status: "rejected",
      code: "INVALID_CONFIG",
    });
    expect(createSourceEngineering(Object.freeze({}))).toEqual({
      status: "rejected",
      code: "INVALID_CONFIG",
    });
    const valid = validConfig();
    const { structuralPolicy: _structuralPolicy, ...missingPolicy } = valid;
    expect(createSourceEngineering(Object.freeze(missingPolicy))).toEqual({
      status: "rejected",
      code: "INVALID_CONFIG",
    });
    for (const structuralPolicy of [
      Object.freeze({
        ...valid.structuralPolicy,
        metricVersion: "caller-complexity",
      }),
      Object.freeze({
        ...valid.structuralPolicy,
        maxFunctionIncrease: 1.5,
      }),
      Object.freeze({
        ...valid.structuralPolicy,
        maxAggregateIncrease: -1,
      }),
    ]) {
      expect(
        createSourceEngineering(Object.freeze({ ...valid, structuralPolicy })),
      ).toEqual({ status: "rejected", code: "INVALID_CONFIG" });
    }
  });

  it("exposes one frozen facade and contains invalid public inputs", async () => {
    const created = createSourceEngineering(validConfig());
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error(created.code);
    const engine = created.sourceEngineering;
    expect(Object.isFrozen(engine)).toBe(true);
    expect(isSourceEngineering(engine)).toBe(true);
    expect(
      isSourceEngineering(
        Object.freeze({
          describe: engine.describe,
          start: engine.start,
          advance: engine.advance,
          verify: engine.verify,
        }),
      ),
    ).toBe(false);
    expect(await engine.describe(undefined)).toEqual({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(engine.start(undefined)).toEqual({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(await engine.advance(undefined)).toEqual({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(engine.verify(undefined)).toEqual({
      status: "rejected",
      code: "RECEIPT_FORGED",
    });
  });

  it("preserves exact unsupported-language rejection", async () => {
    const created = createSourceEngineering(validConfig());
    if (created.status !== "created") throw new Error(created.code);
    const request = describeInput();
    expect(
      await created.sourceEngineering.describe(
        Object.freeze({ ...request, language: "rust" }),
      ),
    ).toEqual({ status: "rejected", code: "UNSUPPORTED_LANGUAGE" });
  });

  it("routes JavaScript and TSX through separately registered AST adapters", async () => {
    for (const fixture of [
      Object.freeze({
        language: "javascript" as const,
        path: "src/value.js",
        sourceText: "export function value() { return 1; }\n",
      }),
      Object.freeze({
        language: "tsx" as const,
        path: "src/view.tsx",
        sourceText: "export function View() { return <main />; }\n",
      }),
    ]) {
      const created = createSourceEngineering(
        describedConfig(fixture.language, fixture.path, fixture.sourceText),
      );
      if (created.status !== "created") throw new Error(created.code);
      const described = await created.sourceEngineering.describe(
        Object.freeze({
          ...describeInput(),
          language: fixture.language,
          targets: Object.freeze([Object.freeze({ path: fixture.path })]),
        }),
      );
      if (described.status !== "described") {
        throw new Error(`${fixture.language}: ${described.code}`);
      }
      expect(described.status).toBe("described");
      expect(described.context.templates[0]?.language).toBe(fixture.language);
      expect(described.context.targets[0]?.declarations[0]?.name).toBe(
        fixture.language === "tsx" ? "View" : "value",
      );
    }
  });

  it("rejects a forged adapter even when every operational method is copied", async () => {
    const config = validConfig();
    const adapter = config.languageAdapters[0];
    if (adapter === undefined) throw new Error("missing adapter fixture");
    const copied = Object.freeze({ ...adapter });
    expect(copied.supportsPath("src/index.ts")).toBe(false);
    expect(
      await copied.parse(
        Object.freeze({
          targetPath: "src/index.ts",
          sourceText: "export function value(): number { return 1; }\n",
        }),
      ),
    ).toEqual({
      status: "rejected",
      code: "INVALID_PARSE_INPUT",
      diagnostics: [],
    });
    expect(
      createSourceEngineering(
        Object.freeze({
          ...config,
          languageAdapters: Object.freeze([copied]),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_CONFIG" });
  });

  it("rejects a method-copy literal registry", () => {
    const config = validConfig();
    expect(
      createSourceEngineering(
        Object.freeze({
          ...config,
          literalRegistry: Object.freeze({
            register: config.literalRegistry.register,
            snapshot: config.literalRegistry.snapshot,
          }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_CONFIG" });
  });

  it("contains delegated authority failures at the describe boundary", async () => {
    const created = createSourceEngineering(validConfig(true));
    if (created.status !== "created") throw new Error(created.code);
    expect(await created.sourceEngineering.describe(describeInput())).toEqual({
      status: "rejected",
      code: "CONTEXT_REJECTED",
    });
  });
});

function describeInput() {
  return Object.freeze({
    requestDigest: digest("request"),
    repository: Object.freeze({
      id: "repo",
      rootIdentity: "root",
      treeDigest: digest("tree"),
      configDigest: digest("config"),
    }),
    language: "typescript",
    objective: "behavioral",
    targets: Object.freeze([Object.freeze({ path: "src/index.ts" })]),
    formatterId: "formatter",
  });
}

function validConfig(throwCapture = false) {
  const sourceEvidence = Object.freeze({
    capture: () => {
      if (throwCapture) throw new Error("capture failed");
      return Promise.resolve(
        Object.freeze({ status: "rejected", code: "SOURCE_CAPTURE_REJECTED" }),
      );
    },
    materializeTemplate: () =>
      Promise.resolve(
        Object.freeze({ status: "rejected", code: "TEMPLATE_REJECTED" }),
      ),
    recoverCapture: () =>
      Object.freeze({ status: "rejected", code: "FORGED_CAPTURE" }),
    recoverTemplate: () =>
      Object.freeze({ status: "rejected", code: "TEMPLATE_REJECTED" }),
  });
  const compiler = createTypeScriptCompilerAuthority(
    Object.freeze({
      repository: Object.freeze({
        repositoryId: "repo",
        rootIdentity: "root",
        treeDigest: digest("tree"),
        configDigest: digest("config"),
        rootPath: resolve(import.meta.dir, "../.."),
        configPath: "tsconfig.json",
      }),
      profile: Object.freeze({
        profileId: "compiler",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
    }),
  );
  if (compiler.status !== "created") {
    throw new Error(`compiler setup failed: ${compiler.code}`);
  }
  const adapter = createTypeScriptAstLanguageAdapter(
    Object.freeze({
      language: "typescript",
      formatterProfiles: Object.freeze([
        Object.freeze({
          profileId: "formatter",
          language: "typescript",
          tool: "biome",
          version: "2.5.4",
          configDigest: digest("formatter-config"),
        }),
      ]),
      compilerAuthority: compiler.authority,
      compilerProfile: Object.freeze({
        profileId: "compiler",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
      symbolIndexAuthority: Object.freeze({ capture: () => undefined }),
    }),
  );
  if (adapter.status !== "created") throw new Error(adapter.code);
  return Object.freeze({
    sourceEvidence,
    languageAdapters: Object.freeze([adapter.adapter]),
    literalRegistry: literalRegistry(),
    structuralPolicy: policy(),
    templates: Object.freeze([
      Object.freeze({
        templateId: "typescript-node",
        language: "typescript",
        schemaText: "TypeScript declaration source",
        description: "A complete TypeScript declaration.",
        bindings: Object.freeze(["declaration"]),
        tool: "template-tool",
        version: "1.0.0",
      }),
    ]),
  });
}

function describedConfig(
  language: "javascript" | "tsx",
  path: string,
  sourceText: string,
) {
  const baselineBytes = Object.freeze([
    ...new TextEncoder().encode(sourceText),
  ]);
  const source = createSourceEvidence(
    Object.freeze({
      sourceCaptureAuthority: Object.freeze({
        capture: (input: Readonly<Record<string, unknown>>) =>
          Object.freeze({
            ...input,
            baselineDigest: digest(sourceText),
            baselineBytes,
          }),
      }),
      templateAuthority: Object.freeze({
        materialize: () => Object.freeze({}),
      }),
      templates: Object.freeze([
        Object.freeze({ id: "declaration", language }),
      ]),
    }),
  );
  if (source.status !== "created") throw new Error(source.code);
  const compiler = createTypeScriptCompilerAuthority(
    Object.freeze({
      repository: Object.freeze({
        repositoryId: "repo",
        rootIdentity: "root",
        treeDigest: digest("tree"),
        configDigest: digest("config"),
        rootPath: resolve(import.meta.dir, "../.."),
        configPath: "tsconfig.json",
      }),
      profile: Object.freeze({
        profileId: "compiler",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
    }),
  );
  if (compiler.status !== "created") throw new Error(compiler.code);
  const adapter = createTypeScriptAstLanguageAdapter(
    Object.freeze({
      language,
      formatterProfiles: Object.freeze([
        Object.freeze({
          profileId: "formatter",
          language,
          tool: "biome",
          version: "2.5.4",
          configDigest: digest("formatter-config"),
        }),
      ]),
      compilerAuthority: compiler.authority,
      compilerProfile: Object.freeze({
        profileId: "compiler",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
      symbolIndexAuthority: Object.freeze({
        capture: () =>
          Object.freeze({
            repositoryId: "repo",
            rootIdentity: "root",
            treeDigest: digest("tree"),
            configDigest: digest("config"),
            complete: true,
            packages: Object.freeze([]),
            documents: Object.freeze([
              Object.freeze({
                path,
                text: sourceText,
                digest: digest(sourceText),
              }),
            ]),
          }),
      }),
    }),
  );
  if (adapter.status !== "created") throw new Error(adapter.code);
  return Object.freeze({
    sourceEvidence: source.evidence,
    languageAdapters: Object.freeze([adapter.adapter]),
    literalRegistry: literalRegistry(),
    structuralPolicy: policy(),
    templates: Object.freeze([
      Object.freeze({
        templateId: "declaration",
        language,
        schemaText: "A complete declaration.",
        description: "A complete AST declaration.",
        bindings: Object.freeze(["declaration"]),
        tool: "template-tool",
        version: "1.0.0",
      }),
    ]),
  });
}

function policy() {
  return Object.freeze({
    metricVersion: "cyclomatic-v1" as const,
    maxFunctionComplexity: 64,
    maxFunctionIncrease: 64,
    maxAggregateIncrease: 128,
  });
}

function literalRegistry() {
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
