import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLiteralRegistry,
  createSourceEngineering,
  createSourceEvidence,
  createTypeScriptAstLanguageAdapter,
  createTypeScriptCompilerAuthority,
  type FormatterAuthorityPort,
  registerTypeScriptFormatterProfile,
  type SourceCaptureAuthorityPort,
  type TemplateAuthorityPort,
  type TypeScriptCompilerAuthority,
  type TypeScriptSymbolIndexAuthorityPort,
} from "@skizzles/source-engineering";
import type { repositoryContext } from "../../support.ts";
import { baselineFor, digest, schemaText } from "./data.ts";

const formatterConfigDigest = digest("formatter-config");

interface SourceFixtureFormatterOptions {
  readonly onAdvanceBlocked?: () => void;
  readonly advanceBarrier?: Promise<void>;
}

type Repository = Awaited<ReturnType<typeof repositoryContext>>;

function createCompilerProject(
  repository: Repository,
  targetPaths: readonly string[],
) {
  const root = mkdtempSync(join(tmpdir(), "skizzles-orchestrator-source-"));
  mkdirSync(join(root, "test"));
  for (const path of targetPaths) {
    writeFileSync(join(root, path), baselineFor(path));
  }
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noImplicitAny: true,
        strictNullChecks: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        useUnknownInCatchVariables: true,
        noEmit: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "esnext",
        allowImportingTsExtensions: true,
      },
      include: ["test/**/*.ts"],
    }),
  );
  const registration = createTypeScriptCompilerAuthority(
    Object.freeze({
      repository: Object.freeze({
        repositoryId: repository.repository.repositoryId,
        rootIdentity: "root-a",
        treeDigest: repository.repository.treeDigest,
        configDigest: repository.repository.contextDigest,
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
  if (registration.status !== "created") {
    rmSync(root, { force: true, recursive: true });
    throw new Error(`compiler setup failed: ${registration.code}`);
  }
  return Object.freeze({
    authority: registration.authority,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  });
}

function createRealSourceEngineering(
  compilerAuthority: TypeScriptCompilerAuthority,
  targetPaths: readonly string[],
  options: SourceFixtureFormatterOptions,
) {
  const sourceEvidence = createEvidence(targetPaths);
  const formatter = registerFormatter(options);
  const symbolIndexAuthority: TypeScriptSymbolIndexAuthorityPort =
    Object.freeze({
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
          documents: Object.freeze(
            targetPaths.map((path) =>
              Object.freeze({
                path,
                text: baselineFor(path),
                digest: digest(baselineFor(path)),
              }),
            ),
          ),
        }),
    });
  const adapter = createTypeScriptAstLanguageAdapter(
    Object.freeze({
      language: "typescript",
      formatterProfiles: Object.freeze([formatter]),
      compilerAuthority,
      compilerProfile: Object.freeze({
        profileId: "strict-typescript",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
      symbolIndexAuthority,
    }),
  );
  if (adapter.status !== "created") {
    throw new Error(`language adapter setup failed: ${adapter.code}`);
  }
  const result = createSourceEngineering(
    Object.freeze({
      sourceEvidence,
      languageAdapters: Object.freeze([adapter.adapter]),
      literalRegistry: sourceLiteralRegistry(),
      structuralPolicy: Object.freeze({
        metricVersion: "cyclomatic-v1" as const,
        maxFunctionComplexity: 64,
        maxFunctionIncrease: 16,
        maxAggregateIncrease: 64,
      }),
      templates: Object.freeze([
        Object.freeze({
          templateId: "typescript-function",
          language: "typescript",
          schemaText,
          description: "A complete function declaration replacement.",
          bindings: Object.freeze(["declaration"]),
          tool: "template-tool",
          version: "1.0.0",
        }),
      ]),
    }),
  );
  if (result.status !== "created") {
    throw new Error(`source engine setup failed: ${result.code}`);
  }
  return result.sourceEngineering;
}

function sourceLiteralRegistry() {
  const created = createLiteralRegistry(
    Object.freeze({
      registryId: "source-parameters",
      registryPath: "src/config/parameters.ts",
      exportName: "SOURCE_PARAMETERS",
    }),
  );
  if (created.status !== "created") {
    throw new Error(`literal registry setup failed: ${created.code}`);
  }
  return created.registry;
}

function createEvidence(targetPaths: readonly string[]) {
  const sourceCaptureAuthority: SourceCaptureAuthorityPort = Object.freeze({
    capture(input: unknown): unknown {
      const bindings = dataRecord(input, [
        "requestDigest",
        "repositoryId",
        "rootIdentity",
        "treeDigest",
        "configDigest",
        "path",
        "language",
      ]);
      const path = bindings.get("path");
      if (typeof path !== "string" || !targetPaths.includes(path)) {
        throw new Error("unexpected source capture path");
      }
      return Object.freeze({
        ...Object.fromEntries(bindings),
        baselineDigest: digest(baselineFor(path)),
        baselineBytes: Object.freeze([
          ...new TextEncoder().encode(baselineFor(path)),
        ]),
      });
    },
  });
  const templateAuthority: TemplateAuthorityPort = Object.freeze({
    materialize(input: unknown): unknown {
      const request = dataRecord(input, [
        "requestDigest",
        "repositoryId",
        "rootIdentity",
        "treeDigest",
        "configDigest",
        "path",
        "language",
        "baselineDigest",
        "templateId",
        "nodeSourceDigest",
        "nodeSource",
      ]);
      return Object.freeze({
        ...Object.fromEntries(
          [...request].filter(([key]) => key !== "nodeSource"),
        ),
        templateDigest: digest("typescript-function-template"),
        tool: "template-tool",
        toolVersion: "1.0.0",
        contentDigest: request.get("nodeSourceDigest"),
        schemaDigest: digest(schemaText),
      });
    },
  });
  const result = createSourceEvidence(
    Object.freeze({
      sourceCaptureAuthority,
      templateAuthority,
      templates: Object.freeze([
        Object.freeze({
          id: "typescript-function",
          language: "typescript",
        }),
      ]),
    }),
  );
  if (result.status !== "created") {
    throw new Error(`source evidence setup failed: ${result.code}`);
  }
  return result.evidence;
}

function registerFormatter(options: SourceFixtureFormatterOptions) {
  const authority: FormatterAuthorityPort = Object.freeze({
    async format(request: Parameters<FormatterAuthorityPort["format"]>[0]) {
      options.onAdvanceBlocked?.();
      await options.advanceBarrier;
      const { sourceText, ...bindings } = request;
      return Object.freeze({ ...bindings, formattedText: sourceText });
    },
  });
  const result = registerTypeScriptFormatterProfile(
    Object.freeze({
      profileId: "formatter",
      language: "typescript",
      tool: "formatter-tool",
      version: "1.0.0",
      configDigest: formatterConfigDigest,
      authority,
    }),
  );
  if (result.status !== "registered") {
    throw new Error(`formatter setup failed: ${result.code}`);
  }
  return result.profile;
}

function dataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("authority input was not an object");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error("authority input keys drifted");
  }
  const result = new Map<string, unknown>();
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("authority input used an accessor");
    }
    result.set(key, descriptor.value);
  }
  return result;
}

export { createCompilerProject, createRealSourceEngineering };
