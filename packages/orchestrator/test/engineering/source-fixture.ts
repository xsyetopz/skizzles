import { createHash } from "node:crypto";
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
import { createLocalRepositoryLeaseAuthority } from "@skizzles/workspace-transaction";
import { digestValue } from "../../src/digest.ts";
import type { ContextOperation } from "../../src/engineering/context.ts";
import { createEngineeringWorkflow } from "../../src/engineering/workflow.ts";
import { createHarness, repositoryContext } from "../support.ts";
import { IsolatedDestination } from "../workflow/isolated-destination.ts";
import { createTestChangeAssurance } from "./assurance-fixture.ts";
import { createTestTaskWorktree } from "./worktree/fixture.ts";

export const targetPath = "test/value.test.ts";
const baseline = "export function value(): number { return 1; }\n";
export const replacement = "export function value(): number { return 2; }";
export const candidate = `${replacement}\n`;
const schemaText = "A complete TypeScript function declaration.";
const formatterConfigDigest = digest("formatter-config");
export async function createFixture() {
  const harness = createHarness();
  const repository = await repositoryContext(harness.orchestrator);
  const compiler = createCompilerProject(repository);
  const taskFixture = createTestTaskWorktree();
  const sourceEngineering = createRealSourceEngineering(compiler.authority);
  const destination = new IsolatedDestination();
  const operations: ContextOperation[] = [];
  let reservation = 0;
  const config = Object.freeze({
    causal: Object.freeze({
      orchestrator: harness.orchestrator,
      publicationIdentity: Object.freeze({
        repositoryId: "repo-a",
        rootIdentity: "root-a",
        ownerId: "worker-a",
      }),
      baselineAuthority: Object.freeze({
        capture(input: {
          readonly baseline: { readonly baselineDigest: string };
          readonly targets: readonly { readonly path: string }[];
        }) {
          return Object.freeze({
            baselineDigest: input.baseline.baselineDigest,
            targets: Object.freeze(
              input.targets.map((target) =>
                Object.freeze({
                  path: target.path,
                  expected: Object.freeze({ state: "missing" }),
                }),
              ),
            ),
          });
        },
      }),
      taskWorktree: taskFixture.taskWorktree,
      taskWorktreeApproval: taskFixture.taskWorktreeApproval,
      transaction: Object.freeze({
        destination,
        leases: createLocalRepositoryLeaseAuthority([
          Object.freeze({
            repositoryId: "repo-a",
            rootIdentity: "root-a",
            ownerId: "worker-a",
          }),
        ]),
      }),
      approvalContext: Object.freeze({
        taskId: "task-a",
        principalId: "maintainer-a",
        operation: "publish",
      }),
    }),
    sourceEngineering,
    changeAssurance: createTestChangeAssurance(),
    contextBudget: Object.freeze({
      reserve(
        input: Parameters<
          import("../../src/engineering/context.ts").ContextBudgetAuthorityPort["reserve"]
        >[0],
      ) {
        operations.push(input.operation);
        reservation += 1;
        return Object.freeze({
          status: "reserved",
          epoch: "epoch-a",
          reservationId: `reservation-${reservation}`,
          requestDigest: digestValue(input),
          usedUnits: 0,
          limitUnits: 100,
          completionReserveUnits: 10,
          requiredUnits: 10,
        });
      },
    }),
    physicalIntegration: Object.freeze({
      attest(): unknown {
        return Object.freeze({ status: "rejected", code: "unused" });
      },
    }),
    validationProfiles: Object.freeze([
      Object.freeze({
        id: "strict",
        language: "typescript",
        objective: "behavioral",
        formatterId: "formatter",
        commandProfileIds: Object.freeze(["validate"]),
        negativeTestCommands: Object.freeze([]),
      }),
    ]),
    discoveryRoot: "packages/orchestrator",
  });
  const created = createEngineeringWorkflow(config);
  if (created.status !== "accepted") {
    compiler.cleanup();
    taskFixture.cleanup();
    throw new Error(`workflow setup failed: ${created.code}`);
  }
  return Object.freeze({
    workflow: created.workflow,
    orchestrator: harness.orchestrator,
    operations,
    destination,
    config,
    repository,
    cleanup: () => {
      compiler.cleanup();
      taskFixture.cleanup();
    },
  });
}

function createCompilerProject(
  repository: Awaited<ReturnType<typeof repositoryContext>>,
) {
  const root = mkdtempSync(join(tmpdir(), "skizzles-orchestrator-source-"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, targetPath), baseline);
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
) {
  const sourceEvidence = createEvidence();
  const formatter = registerFormatter();
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
          documents: Object.freeze([
            Object.freeze({
              path: targetPath,
              text: baseline,
              digest: digest(baseline),
            }),
          ]),
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

function createEvidence() {
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
      if (bindings.get("path") !== targetPath) {
        throw new Error("unexpected source capture path");
      }
      return Object.freeze({
        ...Object.fromEntries(bindings),
        baselineDigest: digest(baseline),
        baselineBytes: Object.freeze([...new TextEncoder().encode(baseline)]),
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

function registerFormatter() {
  const authority: FormatterAuthorityPort = Object.freeze({
    format(request: Parameters<FormatterAuthorityPort["format"]>[0]) {
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

export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
