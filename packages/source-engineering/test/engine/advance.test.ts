// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { digestText } from "../../src/digest.ts";
import { advanceBatch, startBatch } from "../../src/engine/advance.ts";
import { SourceEngineeringState } from "../../src/engine/cursor.ts";
import type {
  ContextState,
  EngineConfig,
} from "../../src/engine/workflow-state.ts";
import { createTypeScriptCompilerAuthority } from "../../src/evidence/compiler.ts";
import type { FormatterPassRequest } from "../../src/evidence/contract.ts";
import { registerTypeScriptFormatterProfile } from "../../src/evidence/formatter.ts";
import { createSourceEvidence } from "../../src/evidence/source.ts";
import {
  createTypeScriptAstLanguageAdapter,
  resolveSourceLanguageAdapter,
} from "../../src/language/adapter.ts";
import { createLiteralRegistry } from "../../src/policy/literal/registry.ts";
import {
  listTypeScriptDeclarations,
  semanticDigest,
} from "../../src/typescript/editor.ts";
import { parseTypeScriptSource } from "../../src/typescript/parser.ts";

const baselineText = "export function value() { return 1; }\n";
const replacementText = "export function value() { return 2; }\n";
const repository = Object.freeze({
  id: "repository",
  rootIdentity: "root",
  treeDigest: digestText("tree"),
  configDigest: digestText("config"),
});
const schemaText = "typescript declaration";
const contextDigest = digestText("context");
const requestDigest = digestText("request");

describe("source engineering batch advancement", () => {
  it("authenticates context, advances edit and format, then exposes validation", async () => {
    const fixture = await createFixture();
    const request = batchRequest(fixture.context.receipt, fixture.nodeDigest);

    const started = startBatch(fixture.config, fixture.state, request);
    expect(started.status).toBe("ready");
    if (started.status !== "ready") {
      throw new Error(started.code);
    }
    expect(started.next).toEqual({
      kind: "edit",
      ordinal: 0,
      operationIndex: 0,
    });

    const edited = await advanceBatch(
      fixture.config,
      fixture.state,
      Object.freeze({ cursor: started.cursor }),
    );
    expect(edited.status).toBe("ready");
    if (edited.status !== "ready") {
      throw new Error(
        edited.status === "rejected"
          ? edited.code
          : "unexpected prepared result",
      );
    }
    expect(edited.next).toEqual({ kind: "format", ordinal: 1 });
    expect(fixture.templateCalls).toBe(1);

    await expect(
      advanceBatch(
        fixture.config,
        fixture.state,
        Object.freeze({ cursor: started.cursor }),
      ),
    ).resolves.toEqual({ status: "rejected", code: "CURSOR_REPLAYED" });

    const formatted = await advanceBatch(
      fixture.config,
      fixture.state,
      Object.freeze({ cursor: edited.cursor }),
    );
    expect(formatted.status).toBe("ready");
    if (formatted.status !== "ready") {
      throw new Error(
        formatted.status === "rejected"
          ? formatted.code
          : "unexpected prepared result",
      );
    }
    expect(formatted.next).toEqual({ kind: "validate", ordinal: 2 });
    expect(fixture.formattedInputs).toEqual([
      `${replacementText}\n`,
      `${replacementText}\n`,
    ]);

    expect(startBatch(fixture.config, fixture.state, request)).toEqual({
      status: "rejected",
      code: "CONTEXT_REPLAYED",
    });
  });

  it("burns authentic cursors when selector drift rejects an edit", async () => {
    const fixture = await createFixture();
    const request = batchRequest(
      fixture.context.receipt,
      digestText("forged-node"),
    );
    const started = startBatch(fixture.config, fixture.state, request);
    if (started.status !== "ready") {
      throw new Error(started.code);
    }
    const input = Object.freeze({ cursor: started.cursor });

    await expect(
      advanceBatch(fixture.config, fixture.state, input),
    ).resolves.toEqual({
      status: "rejected",
      code: "EDIT_REJECTED",
    });
    await expect(
      advanceBatch(fixture.config, fixture.state, input),
    ).resolves.toEqual({
      status: "rejected",
      code: "CURSOR_REPLAYED",
    });
  });
});

async function createFixture(): Promise<{
  readonly config: EngineConfig;
  readonly state: SourceEngineeringState;
  readonly context: ContextState;
  readonly nodeDigest: ReturnType<typeof digestText>;
  readonly formattedInputs: string[];
  readonly templateCalls: number;
}> {
  const baselineBytes = Object.freeze([
    ...new TextEncoder().encode(baselineText),
  ]);
  let templateCalls = 0;
  const evidenceResult = createSourceEvidence({
    sourceCaptureAuthority: {
      capture: (input: Record<string, unknown>) =>
        Object.freeze({
          ...input,
          baselineDigest: digestText(baselineText),
          baselineBytes,
        }),
    },
    templateAuthority: {
      materialize: (input: Record<string, unknown>) => {
        templateCalls += 1;
        const { nodeSource: _nodeSource, ...bindings } = input;
        return Object.freeze({
          ...bindings,
          templateDigest: digestText("template"),
          tool: "template-tool",
          toolVersion: "1.0.0",
          contentDigest: input["nodeSourceDigest"],
          schemaDigest: digestText(schemaText),
        });
      },
    },
    templates: [{ id: "typescript-node", language: "typescript" }],
  });
  if (evidenceResult.status !== "created") {
    throw new Error(evidenceResult.code);
  }
  const sourceEvidence = evidenceResult.evidence;
  const captured = await sourceEvidence.capture(
    Object.freeze({
      requestDigest,
      repositoryId: repository.id,
      rootIdentity: repository.rootIdentity,
      treeDigest: repository.treeDigest,
      configDigest: repository.configDigest,
      path: "src/value.ts",
      language: "typescript",
    }),
  );
  if (captured.status !== "captured") {
    throw new Error(captured.code);
  }
  const parsed = await parseTypeScriptSource({
    targetPath: "src/value.ts",
    sourceText: baselineText,
  });
  if (parsed.status !== "parsed") {
    throw new Error(parsed.code);
  }
  const declaration = listTypeScriptDeclarations(parsed.parsed)[0];
  if (declaration === undefined) {
    throw new Error("missing declaration");
  }

  const formattedInputs: string[] = [];
  const registered = registerTypeScriptFormatterProfile({
    profileId: "formatter",
    language: "typescript",
    tool: "formatter-tool",
    version: "1.0.0",
    configDigest: repository.configDigest,
    authority: {
      format: (request: FormatterPassRequest) => {
        formattedInputs.push(request.sourceText);
        const { sourceText, ...bindings } = request;
        return Object.freeze({ ...bindings, formattedText: sourceText });
      },
    },
  });
  if (registered.status !== "registered") {
    throw new Error(registered.code);
  }

  const compiler = createTypeScriptCompilerAuthority(
    Object.freeze({
      repository: Object.freeze({
        repositoryId: repository.id,
        rootIdentity: repository.rootIdentity,
        treeDigest: repository.treeDigest,
        configDigest: repository.configDigest,
        rootPath: resolve(import.meta.dir, "../.."),
        configPath: "tsconfig.json",
      }),
      profile: Object.freeze({
        profileId: "strict",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
    }),
  );
  if (compiler.status !== "created") throw new Error(compiler.code);
  const adapterCreation = createTypeScriptAstLanguageAdapter(
    Object.freeze({
      language: "typescript",
      formatterProfiles: Object.freeze([registered.profile]),
      compilerAuthority: compiler.authority,
      compilerProfile: Object.freeze({
        profileId: "strict",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
      symbolIndexAuthority: Object.freeze({
        capture: (_input: unknown) => Object.freeze({}),
      }),
    }),
  );
  if (adapterCreation.status !== "created")
    throw new Error(adapterCreation.code);
  const adapter = resolveSourceLanguageAdapter(adapterCreation.adapter);
  if (adapter === undefined) throw new Error("adapter bindings missing");
  const config: EngineConfig = Object.freeze({
    sourceEvidence,
    languageAdapters: new Map([[adapter.language, adapter]]),
    literalRegistry: literalRegistry(),
    templates: new Map([
      [
        "typescript-node",
        Object.freeze({
          templateId: "typescript-node",
          language: "typescript",
          schemaText,
          schemaDigest: digestText(schemaText),
          description: "A TypeScript declaration",
          bindings: Object.freeze([]),
          tool: "template-tool",
          version: "1.0.0",
        }),
      ],
    ]),
  });
  const receipt = Object.freeze({
    receiptDigest: digestText("receipt"),
    contextDigest,
    requestDigest,
    repositoryId: repository.id,
    rootIdentity: repository.rootIdentity,
    treeDigest: repository.treeDigest,
    configDigest: repository.configDigest,
    targetSetDigest: digestText("targets"),
  });
  const context: ContextState = {
    request: Object.freeze({
      requestDigest,
      repository,
      language: "typescript",
      objective: "behavioral",
      targets: Object.freeze([Object.freeze({ path: "src/value.ts" })]),
      formatterId: "formatter",
    }),
    adapter,
    context: Object.freeze({
      contextDigest,
      templates: Object.freeze([
        Object.freeze({
          templateId: "typescript-node",
          language: "typescript",
          schemaText,
          schemaDigest: digestText(schemaText),
          tool: "template-tool",
          version: "1.0.0",
        }),
      ]),
      targets: Object.freeze([
        Object.freeze({
          path: "src/value.ts",
          baselineDigest: digestText(baselineText),
          baselineSemanticDigest: semanticDigest(parsed.parsed.sourceFile),
          declarations: Object.freeze([
            Object.freeze({
              declarationKind: declaration.kind,
              name: declaration.name,
              nodeDigest: declaration.nodeDigest,
            }),
          ]),
        }),
      ]),
    }),
    receipt,
    targets: Object.freeze([
      Object.freeze({
        path: "src/value.ts",
        capture: captured.receipt,
        baselineBytes,
        baseline: parsed.parsed,
      }),
    ]),
    index: Object.freeze({
      ...repository,
      repositoryId: repository.id,
      advisory: true,
      packages: Object.freeze([]),
      sourcePaths: Object.freeze(["src/value.ts"]),
      declarations: Object.freeze([]),
      modules: Object.freeze([]),
      indexDigest: digestText("index"),
    }),
    consumed: false,
  };
  const state = new SourceEngineeringState();
  state.registerContext(context);
  return {
    config,
    state,
    context,
    nodeDigest: declaration.nodeDigest,
    formattedInputs,
    get templateCalls() {
      return templateCalls;
    },
  };
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

function batchRequest(context: object, expectedNodeDigest: string) {
  return Object.freeze({
    requestDigest,
    repository,
    language: "typescript",
    objective: "behavioral",
    targets: Object.freeze([
      Object.freeze({
        path: "src/value.ts",
        operations: Object.freeze([
          Object.freeze({
            kind: "replace",
            selector: Object.freeze({
              declarationKind: "function",
              name: "value",
              expectedNodeDigest,
            }),
            templateId: "typescript-node",
            nodeSource: replacementText,
          }),
        ]),
      }),
    ]),
    formatterId: "formatter",
    faultCases: Object.freeze({
      declarations: Object.freeze([]),
      negativeTests: Object.freeze([]),
    }),
    context,
    contextDigest,
  });
}
