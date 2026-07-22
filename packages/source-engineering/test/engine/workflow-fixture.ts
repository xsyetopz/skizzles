import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createLiteralRegistry,
  createSourceEvidence,
  createTypeScriptAstLanguageAdapter,
  createTypeScriptCompilerAuthority,
  type FormatterAuthorityPort,
  registerTypeScriptFormatterProfile,
  type SourceCaptureAuthorityPort,
  type SourceEngineeringContext,
  type TemplateAuthorityPort,
  type TypeScriptSymbolIndexAuthorityPort,
} from "../../src/index.ts";

export const productionPath = "src/value.ts";
export const testPath = "test/value.test.ts";
const productionBaseline = "export function value(): number { return 1; }\n";
const productionReplacement = "export function value(): number { return 2; }";
export const productionCandidate = `${productionReplacement}\n`;
const testBaseline =
  'export function valueFailure(): string { return "old"; }\n';
const testReplacement =
  'export function valueFailure(): void { const result = { code: "VALUE_FAIL" }; if (result.code === "VALUE_FAIL") { throw new Error(result.code); } }';
export const testCandidate = `${testReplacement}\n`;
const requestDigest = digest("request");
const treeDigest = digest("tree");
const configDigest = digest("config");
const formatterConfigDigest = digest("formatter-config");
export const schemaText = "A complete TypeScript function declaration.";
const repository = Object.freeze({
  id: "repository",
  rootIdentity: "root",
  treeDigest,
  configDigest,
});
const baselines = new Map([
  [productionPath, productionBaseline],
  [testPath, testBaseline],
]);
const compilerRoots: string[] = [];

export function cleanupCompilerRoots(): void {
  for (const root of compilerRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
}

export function createEvidence(captureOrder: string[]) {
  const capture: SourceCaptureAuthorityPort = Object.freeze({
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
      if (typeof path !== "string") throw new Error("capture path missing");
      const source = baselines.get(path);
      if (source === undefined)
        throw new Error(`unexpected capture path ${path}`);
      captureOrder.push(path);
      const baselineBytes = Object.freeze([
        ...new TextEncoder().encode(source),
      ]);
      return Object.freeze({
        ...Object.fromEntries(bindings),
        baselineDigest: digest(source),
        baselineBytes,
      });
    },
  });
  const template: TemplateAuthorityPort = Object.freeze({
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
      sourceCaptureAuthority: capture,
      templateAuthority: template,
      templates: Object.freeze([
        Object.freeze({ id: "typescript-function", language: "typescript" }),
      ]),
    }),
  );
  if (result.status !== "created")
    throw new Error(`source evidence setup failed: ${result.code}`);
  return result.evidence;
}

export function registerFormatter() {
  const authority: FormatterAuthorityPort = Object.freeze({
    format: (request: Parameters<FormatterAuthorityPort["format"]>[0]) => {
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
  if (result.status !== "registered")
    throw new Error(`formatter setup failed: ${result.code}`);
  return result.profile;
}

export function engineConfig(
  sourceEvidence: ReturnType<typeof createEvidence>,
  formatter: ReturnType<typeof registerFormatter>,
) {
  const compiler = createTypeScriptCompilerAuthority(
    Object.freeze({
      repository: Object.freeze({
        repositoryId: repository.id,
        rootIdentity: repository.rootIdentity,
        treeDigest,
        configDigest,
        rootPath: createCompilerRoot(),
        configPath: "tsconfig.json",
      }),
      profile: Object.freeze({
        profileId: "strict-typescript",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
    }),
  );
  if (compiler.status !== "created")
    throw new Error(`compiler setup failed: ${compiler.code}`);
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
            [...baselines]
              .sort(([left], [right]) => compareText(left, right))
              .map(([path, text]) =>
                Object.freeze({ path, text, digest: digest(text) }),
              ),
          ),
        }),
    });
  const adapter = createTypeScriptAstLanguageAdapter(
    Object.freeze({
      language: "typescript",
      formatterProfiles: Object.freeze([formatter]),
      compilerAuthority: compiler.authority,
      compilerProfile: Object.freeze({
        profileId: "strict-typescript",
        toolId: "typescript",
        toolVersion: "7.0.2",
      }),
      symbolIndexAuthority,
    }),
  );
  if (adapter.status !== "created")
    throw new Error(`language adapter setup failed: ${adapter.code}`);
  return Object.freeze({
    sourceEvidence,
    languageAdapters: Object.freeze([adapter.adapter]),
    literalRegistry: literalRegistry(),
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

function createCompilerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skizzles-engine-e2e-"));
  compilerRoots.push(root);
  for (const [path, text] of baselines) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
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
      include: ["src/**/*.ts", "test/**/*.ts"],
    }),
  );
  return root;
}

export function describeRequest() {
  return Object.freeze({
    requestDigest,
    repository,
    language: "typescript",
    objective: "behavioral",
    targets: Object.freeze([
      Object.freeze({ path: testPath }),
      Object.freeze({ path: productionPath }),
    ]),
    formatterId: "formatter",
  });
}

export function batchRequest(
  context: object,
  contextDigest: string,
  productionNodeDigest: string,
  testNodeDigest: string,
) {
  return Object.freeze({
    requestDigest,
    repository,
    language: "typescript",
    objective: "behavioral",
    targets: Object.freeze([
      batchTarget(
        productionPath,
        "value",
        productionNodeDigest,
        productionReplacement,
      ),
      batchTarget(testPath, "valueFailure", testNodeDigest, testReplacement),
    ]),
    formatterId: "formatter",
    faultCases: Object.freeze({
      declarations: Object.freeze([
        Object.freeze({
          productionPath,
          failureCodes: Object.freeze(["VALUE_FAIL"]),
        }),
      ]),
      negativeTests: Object.freeze([
        Object.freeze({ productionPath, testPath }),
      ]),
    }),
    context,
    contextDigest,
  });
}

function batchTarget(
  path: string,
  name: string,
  expectedNodeDigest: string,
  nodeSource: string,
) {
  return Object.freeze({
    path,
    operations: Object.freeze([
      Object.freeze({
        kind: "replace",
        selector: Object.freeze({
          declarationKind: "function",
          name,
          expectedNodeDigest,
        }),
        templateId: "typescript-function",
        nodeSource,
      }),
    ]),
  });
}

export function declaration(
  context: SourceEngineeringContext,
  path: string,
  name: string,
) {
  const target = context.targets.find((candidate) => candidate.path === path);
  const found = target?.declarations.find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined)
    throw new Error(`missing declaration ${path}:${name}`);
  return found;
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
  )
    throw new Error("authority input keys drifted");
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

export function textOf(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) throw new Error("prepared artifact missing");
  return new TextDecoder().decode(bytes);
}

export function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
