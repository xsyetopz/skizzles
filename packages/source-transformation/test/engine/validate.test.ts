import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCandidateManifest } from "@skizzles/candidate-manifest";
import { digestBytes, digestText } from "../../src/digest.ts";
import type { SourceEngineeringContextReceipt } from "../../src/engine/contract.ts";
import { SourceEngineeringState } from "../../src/engine/cursor.ts";
import { validateBatch, verifyPrepared } from "../../src/engine/validate.ts";
import type {
  BatchState,
  BatchTargetState,
  ContextState,
  EngineConfig,
} from "../../src/engine/workflow-state.ts";
import type { TypeScriptCompilerAuthority } from "../../src/evidence/compiler.ts";
import { createTypeScriptCompilerAuthority } from "../../src/evidence/compiler.ts";
import type { FormatterProvenanceReceipt } from "../../src/evidence/contract.ts";
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
import {
  buildLocalTypeScriptSymbolIndex,
  type LocalTypeScriptSymbolIndex,
} from "../../src/typescript/symbols.ts";

const requestDigest = digestText("request");
const treeDigest = digestText("tree");
const configDigest = digestText("config");
const formatterConfigDigest = digestText("formatter-config");
const repository = Object.freeze({
  id: "repository",
  rootIdentity: "root",
  treeDigest,
  configDigest,
});
const compilerRoots: string[] = [];

afterEach(() => {
  for (const root of compilerRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("engine validation", () => {
  it("validates all evidence and verifies exact artifacts once", async () => {
    const fixture = await createFixture();
    const result = await validateBatch(
      fixture.config,
      fixture.state,
      fixture.batch,
    );
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") {
      throw new Error(`unexpected ${result.code}`);
    }

    expect(result.artifacts.map(({ path }) => path)).toEqual([
      "test/example.test.ts",
    ]);
    expect(Object.isFrozen(result.artifacts)).toBe(true);
    expect(Object.isFrozen(result.receipt.targetReceipts)).toBe(true);
    expect(result.receipt.indexReceipt).toMatchObject({
      status: "indexed",
      indexDigest: fixture.index.indexDigest,
    });
    expect(result.receipt.compilerReceipt.receipts).toHaveLength(1);
    expect(result.receipt.policyReceipt.findingCount).toBe(0);
    expect(result.receipt.policyReceipt.literalRegistryDigest).toBe(
      fixture.config.literalRegistry.snapshot().registryDigest,
    );
    expect(result.receipt.candidateManifestDigest).toBe(
      createCandidateManifest(
        result.receipt.targetReceipts.map(({ path, candidateDigest }) =>
          Object.freeze({
            path,
            operation: "write" as const,
            contentDigest: candidateDigest,
          }),
        ),
      ).manifestDigest,
    );

    const first = result.artifacts[0]?.readBytes();
    const second = result.artifacts[0]?.readBytes();
    expect(first).not.toBe(second);
    if (first !== undefined) first.fill(0);
    expect(result.artifacts[0]?.readBytes()).toEqual(
      new TextEncoder().encode(fixture.candidate),
    );

    const verifyInput = Object.freeze({
      artifacts: result.artifacts,
      receipt: result.receipt,
    });
    expect(verifyPrepared(fixture.state, verifyInput)).toEqual({
      status: "valid",
      candidateDigest: result.receipt.candidateDigest,
      provenanceDigest: result.receipt.provenanceDigest,
      validationDigest: result.receipt.validationDigest,
    });
    expect(verifyPrepared(fixture.state, verifyInput)).toEqual({
      status: "rejected",
      code: "RECEIPT_REPLAYED",
    });
  });

  it("rejects artifact-array substitution and consumes the authentic receipt", async () => {
    const fixture = await createFixture();
    const result = await validateBatch(
      fixture.config,
      fixture.state,
      fixture.batch,
    );
    if (result.status !== "prepared") {
      throw new Error(`unexpected ${result.code}`);
    }
    expect(
      verifyPrepared(
        fixture.state,
        Object.freeze({
          artifacts: Object.freeze([...result.artifacts]),
          receipt: result.receipt,
        }),
      ),
    ).toEqual({ status: "rejected", code: "ARTIFACT_REJECTED" });
    expect(
      verifyPrepared(
        fixture.state,
        Object.freeze({ artifacts: result.artifacts, receipt: result.receipt }),
      ),
    ).toEqual({ status: "rejected", code: "RECEIPT_REPLAYED" });
  });

  it("keeps compiler failure authoritative over the complete local index", async () => {
    const fixture = await createFixture({ compilerPassed: false });
    expect(
      await validateBatch(fixture.config, fixture.state, fixture.batch),
    ).toEqual({
      status: "rejected",
      code: "COMPILER_REJECTED",
    });
  });

  it("runs policy once over the complete changed set and rejects findings", async () => {
    const fixture = await createFixture({
      candidate:
        "try { run(); } catch (error) {}\nexport function alpha() { return 2; }",
    });
    expect(
      await validateBatch(fixture.config, fixture.state, fixture.batch),
    ).toEqual({
      status: "rejected",
      code: "POLICY_REJECTED",
    });
  });

  it("rejects an index that does not cover every target", async () => {
    const fixture = await createFixture({ indexPath: "test/other.test.ts" });
    expect(
      await validateBatch(fixture.config, fixture.state, fixture.batch),
    ).toEqual({
      status: "rejected",
      code: "CONTEXT_DRIFTED",
    });
  });

  it("reparses candidate bytes and rejects syntax drift", async () => {
    const fixture = await createFixture();
    const target = fixture.batch.targets[0];
    if (target === undefined) {
      throw new Error("validation fixture target missing");
    }
    target.candidate = Object.freeze({
      ...target.candidate,
      text: "export function alpha( {",
    });
    expect(
      await validateBatch(fixture.config, fixture.state, fixture.batch),
    ).toEqual({
      status: "rejected",
      code: "ARTIFACT_REJECTED",
    });
  });
});

interface FixtureOptions {
  readonly candidate?: string;
  readonly compilerPassed?: boolean;
  readonly indexPath?: string;
}

interface Fixture {
  readonly state: SourceEngineeringState;
  readonly config: EngineConfig;
  readonly batch: BatchState;
  readonly index: LocalTypeScriptSymbolIndex;
  readonly candidate: string;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const path = "test/example.test.ts";
  const baseline = "export function alpha() { return 1; }";
  const candidate =
    options.compilerPassed === false
      ? "export const invalid: string = 1;"
      : (options.candidate ?? "export function alpha() { return 2; }");
  const baselineBytes = Object.freeze([...new TextEncoder().encode(baseline)]);
  const sourceCreation = createSourceEvidence({
    sourceCaptureAuthority: {
      capture(input: Readonly<Record<string, unknown>>): unknown {
        return Object.freeze({
          ...input,
          baselineDigest: digestBytes(Uint8Array.from(baselineBytes)),
          baselineBytes,
        });
      },
    },
    templateAuthority: {
      materialize: (): never => {
        throw new Error("unused");
      },
    },
    templates: Object.freeze([
      Object.freeze({ id: "replace", language: "typescript" }),
    ]),
  });
  if (sourceCreation.status !== "created") {
    throw new Error("source evidence setup failed");
  }
  const capture = await sourceCreation.evidence.capture({
    requestDigest,
    repositoryId: repository.id,
    rootIdentity: repository.rootIdentity,
    treeDigest,
    configDigest,
    path,
    language: "typescript",
  });
  if (capture.status !== "captured") throw new Error("capture setup failed");
  const baselineParsed = await parsed(path, baseline);
  const candidateParsed = await parsed(path, candidate);
  const index = await buildIndex(options.indexPath ?? path, baseline);
  const formatterReceipt = formatter(path, candidate, candidateParsed);
  const profile = Object.freeze({
    profileId: "formatter",
    language: "typescript" as const,
    tool: "biome",
    version: "2.5.4",
    configDigest: formatterConfigDigest,
  });
  const adapterCreation = createTypeScriptAstLanguageAdapter(
    Object.freeze({
      language: "typescript",
      formatterProfiles: Object.freeze([profile]),
      compilerAuthority: compilerAuthority(path, baseline),
      compilerProfile: Object.freeze({
        profileId: "strict-typescript",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
      symbolIndexAuthority: Object.freeze({
        capture: (): never => {
          throw new Error("unused");
        },
      }),
    }),
  );
  if (adapterCreation.status !== "created") {
    throw new Error(adapterCreation.code);
  }
  const adapter = resolveSourceLanguageAdapter(adapterCreation.adapter);
  if (adapter === undefined) throw new Error("adapter bindings missing");
  const config: EngineConfig = Object.freeze({
    sourceEvidence: sourceCreation.evidence,
    languageAdapters: new Map([[adapter.language, adapter]]),
    literalRegistry: literalRegistry(),
    templates: new Map(),
    structuralPolicy: Object.freeze({
      metricVersion: "cyclomatic-v1",
      maxFunctionComplexity: 64,
      maxFunctionIncrease: 64,
      maxAggregateIncrease: 128,
    }),
  });
  const contextReceipt: SourceEngineeringContextReceipt = Object.freeze({
    receiptDigest: digestText("context-receipt"),
    contextDigest: digestText("context"),
    requestDigest,
    repositoryId: repository.id,
    rootIdentity: repository.rootIdentity,
    treeDigest,
    configDigest,
    targetSetDigest: digestText(path),
  });
  const context: ContextState = {
    request: Object.freeze({
      requestDigest,
      repository,
      language: "typescript",
      objective: "behavioral",
      targets: Object.freeze([Object.freeze({ path })]),
      formatterId: "formatter",
    }),
    adapter,
    context: Object.freeze({
      contextDigest: contextReceipt.contextDigest,
      templates: Object.freeze([]),
      targets: Object.freeze([]),
    }),
    receipt: contextReceipt,
    targets: Object.freeze([]),
    index,
    consumed: true,
  };
  const target: BatchTargetState = {
    path,
    capture: capture.receipt,
    baselineBytes,
    baseline: baselineParsed,
    operations: Object.freeze([
      Object.freeze({
        epoch: 1,
        kind: "delete",
        selector: Object.freeze({
          declarationKind: "function",
          name: "alpha",
          expectedNodeDigest: digestText("node"),
        }),
      }),
    ]),
    candidate: candidateParsed,
    astChanges: [
      Object.freeze({
        epoch: 1,
        change: astDeletion(path, baselineParsed),
      }),
    ],
    templateReceipts: [],
    formatterReceipt,
  };
  const targetSetDigest = digestText(JSON.stringify([path]));
  const baselineCandidateSetDigest = digestText(
    JSON.stringify([
      {
        path,
        candidateDigest: digestText(baseline),
        semanticDigest: semanticDigest(baselineParsed.sourceFile),
      },
    ]),
  );
  const candidateSetDigest = digestText(
    JSON.stringify([
      {
        path,
        candidateDigest: digestText(candidate),
        semanticDigest: semanticDigest(candidateParsed.sourceFile),
      },
    ]),
  );
  const compiler = await adapter.adapter.validateCandidate(
    Object.freeze({
      requestDigest,
      repositoryId: repository.id,
      rootIdentity: repository.rootIdentity,
      treeDigest,
      configDigest,
      targetPath: path,
      candidateDigest: digestText(candidate),
      semanticDigest: semanticDigest(candidateParsed.sourceFile),
      epoch: 1,
      epochKind: "format",
      predecessorCandidateSetDigest: baselineCandidateSetDigest,
      candidateSetDigest,
      targetSetDigest,
      targets: Object.freeze([
        Object.freeze({
          path,
          candidateDigest: digestText(candidate),
          semanticDigest: semanticDigest(candidateParsed.sourceFile),
          candidateBytes: Object.freeze([
            ...new TextEncoder().encode(candidate),
          ]),
        }),
      ]),
      predecessor: null,
    }),
  );
  const batch: BatchState = {
    request: Object.freeze({
      ...context.request,
      context: contextReceipt,
      contextDigest: contextReceipt.contextDigest,
      targets: Object.freeze([
        Object.freeze({ path, operations: target.operations }),
      ]),
      faultCases: Object.freeze({
        declarations: Object.freeze([]),
        negativeTests: Object.freeze([]),
      }),
    }),
    targets: [target],
    steps: Object.freeze([
      Object.freeze({ kind: "format", ordinal: 0, epoch: 1 }),
      Object.freeze({ kind: "validate", ordinal: 1 }),
    ]),
    context,
    compilerReceipts: compiler.status === "accepted" ? [compiler.receipt] : [],
    targetSetDigest,
    baselineCandidateSetDigest,
    candidateSetDigest,
    step: 1,
  };
  return {
    state: new SourceEngineeringState(),
    config,
    batch,
    index,
    candidate,
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

async function parsed(path: string, text: string) {
  const result = await parseTypeScriptSource({
    targetPath: path,
    sourceText: text,
  });
  if (result.status !== "parsed") {
    throw new Error(`parse failed: ${result.code}`);
  }
  return result.parsed;
}

async function buildIndex(
  path: string,
  text: string,
): Promise<LocalTypeScriptSymbolIndex> {
  const result = await buildLocalTypeScriptSymbolIndex(
    {
      capture: () =>
        Object.freeze({
          repositoryId: repository.id,
          rootIdentity: repository.rootIdentity,
          treeDigest,
          configDigest,
          complete: true,
          packages: Object.freeze([]),
          documents: Object.freeze([
            Object.freeze({ path, text, digest: digestText(text) }),
          ]),
        }),
    },
    {
      repositoryId: repository.id,
      rootIdentity: repository.rootIdentity,
      treeDigest,
      configDigest,
    },
  );
  if (result.status !== "indexed") {
    throw new Error(`index failed: ${result.code}`);
  }
  return result.index;
}

function formatter(
  path: string,
  candidate: string,
  parsedCandidate: Awaited<ReturnType<typeof parsed>>,
): FormatterProvenanceReceipt {
  const digest = digestText(candidate);
  const semantic = semanticDigest(parsedCandidate.sourceFile);
  return Object.freeze({
    path,
    profileId: "formatter",
    tool: "biome",
    version: "2.5.4",
    treeDigest,
    configDigest: formatterConfigDigest,
    candidateDigest: digestText("pre-format"),
    candidateSemanticDigest: semantic,
    pass1Digest: digest,
    pass2Digest: digest,
    formattedDigest: digest,
    formattedSemanticDigest: semantic,
    provenanceDigest: digestText("formatter-provenance"),
    formattedBytes: Object.freeze([...new TextEncoder().encode(candidate)]),
  });
}

function astDeletion(
  path: string,
  baseline: Awaited<ReturnType<typeof parsed>>,
) {
  const declaration = listTypeScriptDeclarations(baseline)[0];
  if (declaration === undefined) {
    throw new Error("baseline declaration missing");
  }
  const span = Object.freeze({
    start: declaration.start,
    end: declaration.end,
  });
  const nodeId = digestText(
    JSON.stringify({
      path,
      declarationKind: declaration.kind,
      name: declaration.name,
    }),
  );
  const identityMaterial = {
    nodeId,
    declarationKind: declaration.kind,
    name: declaration.name,
    nodeDigest: declaration.nodeDigest,
    span,
  };
  const anchor = Object.freeze({
    ...identityMaterial,
    identityDigest: digestText(JSON.stringify(identityMaterial)),
  });
  const material = {
    path,
    operation: "delete" as const,
    anchor,
    baselineNode: anchor,
    candidateNode: null,
  };
  return Object.freeze({
    ...material,
    changeDigest: digestText(JSON.stringify(material)),
  });
}

function compilerAuthority(
  path: string,
  baseline: string,
): TypeScriptCompilerAuthority {
  const root = mkdtempSync(join(tmpdir(), "skizzles-validate-"));
  compilerRoots.push(root);
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, baseline);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        useUnknownInCatchVariables: true,
        noEmit: true,
      },
      include: ["test/**/*.ts"],
    }),
  );
  const created = createTypeScriptCompilerAuthority(
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
        profileId: "strict-typescript",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
    }),
  );
  if (created.status !== "created") {
    throw new Error(`compiler setup failed: ${created.code}`);
  }
  return created.authority;
}
