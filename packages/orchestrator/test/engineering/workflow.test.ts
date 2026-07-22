// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import process from "node:process";
import { createChangeDeclaration } from "@skizzles/change-assurance";
import type { SourceEngineering } from "@skizzles/source-engineering";
import { createLocalRepositoryLeaseAuthority } from "@skizzles/workspace-transaction";
import { digestBytes, digestValue } from "../../src/digest.ts";
import type { EngineeringWorkflowConfig } from "../../src/engineering/contract.ts";
import { EngineeringCoordinator } from "../../src/engineering/coordinator.ts";
import {
  snapshotArray,
  snapshotRecord,
} from "../../src/engineering/snapshot.ts";
import { createCausalWorkflow } from "../../src/workflow/causal-workflow.ts";
import type { CommandAuditProfile } from "../../src/workflow/contract.ts";
import { createHarness, repositoryContext } from "../support.ts";
import { IsolatedDestination } from "../workflow/isolated-destination.ts";
import {
  createTestChangeAssurance,
  createTestChangeDeclaration,
} from "./assurance-fixture.ts";

const candidate = new TextEncoder().encode(
  "export function run(): boolean { return true; }\n",
);
const candidateDigest = digestBytes(candidate);

describe("engineering assurance workflow", () => {
  it("describes context, derives a candidate, and keeps publication behind approval", async () => {
    const fixture = createFixture();
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    expect(described.status).toBe("described");
    if (described.status !== "described") return;
    expect(described.context.templates[0]?.schemaText).toContain("declaration");
    const prepared = await fixture.workflow.prepare({
      ...repository,
      context: described.context,
      changeDeclaration: createTestChangeDeclaration({
        requestDigest: repository.request.intentDigest,
        repositoryId: repository.repository.repositoryId,
        targets: Object.freeze([
          Object.freeze({ path: "src/example.ts", candidateDigest }),
        ]),
      }),
      targets: [
        {
          path: "src/example.ts",
          operations: [
            {
              kind: "replace",
              selector: {
                declarationKind: "function",
                name: "run",
                expectedNodeDigest: candidateDigest,
              },
              templateId: "function-template",
              nodeSource: "export function run(): boolean { return true; }",
            },
          ],
        },
      ],
      faultDeclarations: { declarations: [], negativeTests: [] },
      validationProfile: "strict",
      integrations: [],
    });
    expect(prepared.status).toBe("awaiting-approval");
    expect(fixture.destination.currentText("src/example.ts")).toBeUndefined();
    expect(fixture.physicalCalls()).toBe(0);
    if (prepared.status !== "awaiting-approval") return;
    expect(prepared.review.preview.candidateDigest).toBe(candidateDigest);
    const promoted = await fixture.workflow.approveAndPromote({
      review: prepared.review,
      token: "approve",
    });
    expect(promoted.status).toBe("completed");
    expect(fixture.destination.currentText("src/example.ts")).toBe(
      new TextDecoder().decode(candidate),
    );
  });

  it("stops rejected assurance before physical integration or Phase 2", async () => {
    const fixture = createFixture();
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    expect(described.status).toBe("described");
    if (described.status !== "described") return;
    const declaration = createChangeDeclaration(
      Object.freeze({
        requestDigest: repository.request.intentDigest,
        repositoryId: repository.repository.repositoryId,
        targets: Object.freeze([
          Object.freeze({ path: "src/example.ts", operation: "write" }),
        ]),
        plans: Object.freeze({
          "middleware-security": Object.freeze({}),
          "migration-configuration-secrets": Object.freeze({
            migrations: Object.freeze([]),
          }),
          performance: Object.freeze({ schemaVersion: 1 }),
          "supply-chain": Object.freeze({
            schemaVersion: 1,
            changes: Object.freeze([]),
          }),
        }),
      }),
    );
    expect(declaration.status).toBe("created");
    if (declaration.status !== "created") return;
    const result = await fixture.workflow.prepare({
      ...repository,
      context: described.context,
      changeDeclaration: declaration.declaration,
      targets: [
        {
          path: "src/example.ts",
          operations: [
            {
              kind: "replace",
              selector: {
                declarationKind: "function",
                name: "run",
                expectedNodeDigest: candidateDigest,
              },
              templateId: "function-template",
              nodeSource: "export function run(): boolean { return true; }",
            },
          ],
        },
      ],
      faultDeclarations: { declarations: [], negativeTests: [] },
      validationProfile: "strict",
      integrations: [],
    });
    expect(result).toEqual({
      status: "rejected",
      code: "CHANGE_ASSURANCE_REJECTED",
      cleanup: null,
    });
    expect(fixture.physicalCalls()).toBe(0);
    expect(fixture.destination.currentText("src/example.ts")).toBeUndefined();
  });

  it("never accepts whole candidate bytes or caller commands", async () => {
    const fixture = createFixture();
    const repository = await repositoryContext(fixture.orchestrator);
    await expect(
      fixture.workflow.prepare({
        ...repository,
        context: Object.freeze({}),
        targets: [],
        faultDeclarations: { declarations: [], negativeTests: [] },
        validationProfile: "strict",
        integrations: [],
        candidateBytes: Array.from(candidate),
        commands: ["arbitrary"],
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "INVALID_WORKFLOW_INPUT",
    });
  });

  it("resumes a one-shot paused workflow with its bound target baseline", async () => {
    const fixture = createFixture({ pauseOnce: true });
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    if (described.status !== "described") throw new Error("describe rejected");
    const paused = await prepareExample(fixture, repository, described.context);
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") return;
    const resumed = await fixture.workflow.continue({
      continuation: paused.continuation,
    });
    expect(resumed.status).toBe("awaiting-approval");
    await expect(
      fixture.workflow.continue({ continuation: paused.continuation }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });
    if (resumed.status === "awaiting-approval") {
      await fixture.workflow.reject({ review: resumed.review });
    }
  });

  it("atomically cancels an abandoned continuation and releases its target", async () => {
    const fixture = createFixture({ pauseOnce: true });
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    if (described.status !== "described") throw new Error("describe rejected");
    const paused = await prepareExample(fixture, repository, described.context);
    if (paused.status !== "paused") throw new Error("workflow did not pause");
    await expect(
      fixture.workflow.cancelContinuation({
        continuation: paused.continuation,
      }),
    ).resolves.toEqual({ status: "cancelled" });
    await expect(
      fixture.workflow.cancelContinuation({
        continuation: paused.continuation,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });

    const retriedDescription = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    if (retriedDescription.status !== "described") {
      throw new Error("retry describe rejected");
    }
    const retried = await prepareExample(
      fixture,
      repository,
      retriedDescription.context,
    );
    expect(retried.status).toBe("awaiting-approval");
    if (retried.status === "awaiting-approval") {
      await fixture.workflow.reject({ review: retried.review });
    }
  });

  it("revalidates source evidence immediately before promotion", async () => {
    const fixture = createFixture({ rejectVerification: true });
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    if (described.status !== "described") throw new Error("describe rejected");
    const prepared = await prepareExample(
      fixture,
      repository,
      described.context,
    );
    if (prepared.status !== "awaiting-approval") {
      throw new Error("prepare rejected");
    }
    await expect(
      fixture.workflow.approveAndPromote({
        review: prepared.review,
        token: "approve",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "ENGINEERING_EVIDENCE_REJECTED",
    });
    expect(fixture.destination.currentText("src/example.ts")).toBeUndefined();
  });

  it("routes the trusted validation-profile language to source engineering", async () => {
    const fixture = createFixture({
      language: "javascript",
      targetPath: "src/example.js",
    });
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.js"],
      validationProfile: "strict",
    });
    expect(described.status).toBe("described");
  });
});

function createFixture(
  options: {
    readonly pauseOnce?: boolean;
    readonly rejectVerification?: boolean;
    readonly language?: string;
    readonly targetPath?: string;
  } = {},
) {
  const language = options.language ?? "typescript";
  const targetPath = options.targetPath ?? "src/example.ts";
  const harness = createHarness();
  const destination = new IsolatedDestination();
  const contextDigest = digestValue({ context: language });
  const sourceReceipt = Object.freeze({
    requestDigest: candidateDigest,
    contextDigest,
    contextReceiptDigest: candidateDigest,
    baselineDigest: candidateDigest,
    candidateDigest,
    targetReceipts: Object.freeze([
      Object.freeze({
        path: targetPath,
        baselineDigest: candidateDigest,
        candidateDigest,
        baselineSemanticDigest: candidateDigest,
        candidateSemanticDigest: candidateDigest,
        changedDeclarations: Object.freeze([]),
        templateReceipts: Object.freeze([]),
        formatterReceipt: Object.freeze({
          path: targetPath,
          profileId: "biome",
          tool: "biome",
          version: "2.5.4",
          treeDigest: candidateDigest,
          configDigest: candidateDigest,
          candidateDigest,
          candidateSemanticDigest: candidateDigest,
          pass1Digest: candidateDigest,
          pass2Digest: candidateDigest,
          formattedDigest: candidateDigest,
          formattedSemanticDigest: candidateDigest,
          provenanceDigest: candidateDigest,
          formattedBytes: Object.freeze(Array.from(candidate)),
        }),
      }),
    ]),
    indexReceipt: Object.freeze({
      status: "indexed",
      language,
      advisory: true,
      indexDigest: candidateDigest,
    }),
    compilerReceipt: Object.freeze({
      receipts: Object.freeze([]),
      receiptDigest: candidateDigest,
    }),
    policyReceipt: Object.freeze({
      findingCount: 0,
      changeSetDigest: candidateDigest,
      literalRegistryDigest: candidateDigest,
      observedNegativeTests: Object.freeze([]),
      faultEvidenceDigest: candidateDigest,
      receiptDigest: candidateDigest,
    }),
    provenanceDigest: candidateDigest,
    validationDigest: candidateDigest,
  });
  const artifact = Object.freeze({
    path: targetPath,
    baselineDigest: candidateDigest,
    baselineByteLength: candidate.byteLength,
    digest: candidateDigest,
    byteLength: candidate.byteLength,
    readBaselineBytes: (): Uint8Array => Uint8Array.from(candidate),
    readBytes: (): Uint8Array => Uint8Array.from(candidate),
  });
  let reservations = 0;
  let paused = false;
  let physicalCalls = 0;
  let activeRequestDigest = candidateDigest;
  const validationCommand: CommandAuditProfile = Object.freeze({
    id: "validate",
    argv: Object.freeze([
      process.execPath,
      "-e",
      `if (!(await Bun.file('${targetPath}').exists())) process.exit(9)`,
    ]),
    env: Object.freeze({}),
    dependencyPackages: Object.freeze([]),
    timeoutMilliseconds: 5000,
    maximumOutputBytes: 10_000,
    drainMilliseconds: 1000,
    signalGraceMilliseconds: 1000,
    allowedExitCodes: Object.freeze([0]),
    stderr: "must-be-empty",
  });
  const sourceEngineering: SourceEngineering = Object.freeze({
    async describe(input: unknown) {
      const request = snapshotRecord(input, [
        "requestDigest",
        "repository",
        "language",
        "objective",
        "formatterId",
        "targets",
      ]);
      const repository = snapshotRecord(request?.["repository"], [
        "id",
        "rootIdentity",
        "treeDigest",
        "configDigest",
      ]);
      const targets = snapshotArray(request?.["targets"], 8);
      const paths = targets?.map((target) => {
        const value = snapshotRecord(target, ["path"]);
        return typeof value?.["path"] === "string" ? value["path"] : "";
      });
      if (
        request === undefined ||
        repository === undefined ||
        !isDigest(request["requestDigest"]) ||
        !isDigest(repository["treeDigest"]) ||
        !isDigest(repository["configDigest"]) ||
        typeof repository["id"] !== "string" ||
        typeof repository["rootIdentity"] !== "string" ||
        paths === undefined ||
        paths.some((path) => path.length === 0) ||
        request["language"] !== language
      ) {
        return Object.freeze({ status: "rejected", code: "INVALID_INPUT" });
      }
      return Object.freeze({
        status: "described",
        context: Object.freeze({
          contextDigest,
          templates: Object.freeze([
            Object.freeze({
              templateId: "function-template",
              language,
              schemaText: "TypeScript declaration",
              schemaDigest: candidateDigest,
              tool: "fixture",
              version: "1",
            }),
          ]),
          targets: Object.freeze([
            Object.freeze({
              path: targetPath,
              baselineDigest: candidateDigest,
              baselineSemanticDigest: candidateDigest,
              declarations: Object.freeze([]),
            }),
          ]),
        }),
        receipt: Object.freeze({
          receiptDigest: candidateDigest,
          requestDigest: request["requestDigest"],
          repositoryId: repository["id"],
          rootIdentity: repository["rootIdentity"],
          treeDigest: repository["treeDigest"],
          configDigest: repository["configDigest"],
          targetSetDigest: digestValue(paths),
          contextDigest,
        }),
      });
    },
    start(input: unknown) {
      const request = snapshotRecord(input, [
        "requestDigest",
        "repository",
        "language",
        "objective",
        "targets",
        "formatterId",
        "faultCases",
        "context",
        "contextDigest",
      ]);
      if (!isDigest(request?.["requestDigest"])) {
        return Object.freeze({ status: "rejected", code: "INVALID_INPUT" });
      }
      activeRequestDigest = request["requestDigest"];
      return Object.freeze({
        status: "ready",
        cursor: Object.freeze({
          cursorId: "cursor-a",
          requestDigest: activeRequestDigest,
          stateDigest: candidateDigest,
          candidateDigest,
          step: 0,
          totalSteps: 1,
        }),
        next: Object.freeze({ kind: "validate", ordinal: 0 }),
      });
    },
    async advance() {
      return Object.freeze({
        status: "prepared",
        artifacts: Object.freeze([artifact]),
        receipt: Object.freeze({
          ...sourceReceipt,
          requestDigest: activeRequestDigest,
        }),
      });
    },
    verify() {
      if (options.rejectVerification === true) {
        return Object.freeze({ status: "rejected", code: "RECEIPT_FORGED" });
      }
      return Object.freeze({
        status: "valid",
        candidateDigest,
        provenanceDigest: candidateDigest,
        validationDigest: candidateDigest,
      });
    },
  });
  const config: EngineeringWorkflowConfig = Object.freeze({
    causal: {
      orchestrator: harness.orchestrator,
      publicationIdentity: {
        repositoryId: "repo-a",
        rootIdentity: "root-a",
        ownerId: "worker-a",
      },
      baselineAuthority: {
        capture(input: {
          readonly baseline: { readonly baselineDigest: string };
          readonly targets: readonly { readonly path: string }[];
        }) {
          return {
            baselineDigest: input.baseline.baselineDigest,
            targets: input.targets.map((target) => ({
              path: target.path,
              expected: { state: "missing" },
            })),
          };
        },
      },
      transaction: {
        destination,
        leases: createLocalRepositoryLeaseAuthority([
          {
            repositoryId: "repo-a",
            rootIdentity: "root-a",
            ownerId: "worker-a",
          },
        ]),
      },
      workspaceUsageLimits: {
        byteLimit: 2_000_000,
        entryLimit: 500,
        scanLimit: 500,
      },
      commandProfiles: Object.freeze([validationCommand]),
      approvalContext: {
        taskId: "task-a",
        principalId: "maintainer-a",
        operation: "publish",
      },
    },
    sourceEngineering,
    changeAssurance: createTestChangeAssurance(),
    contextBudget: {
      reserve(input: unknown): unknown {
        reservations += 1;
        if (options.pauseOnce === true && !paused && reservations === 2) {
          paused = true;
          return Object.freeze({
            status: "paused",
            epoch: "epoch-a",
            requestDigest: digestValue(input),
            usedUnits: 90,
            limitUnits: 100,
            completionReserveUnits: 10,
            requiredUnits: 10,
          });
        }
        return Object.freeze({
          status: "reserved",
          epoch: "epoch-a",
          reservationId: `reservation-${crypto.randomUUID()}`,
          requestDigest: digestValue(input),
          usedUnits: 0,
          limitUnits: 100,
          completionReserveUnits: 10,
          requiredUnits: 10,
        });
      },
    },
    physicalIntegration: {
      attest(): unknown {
        physicalCalls += 1;
        return { status: "rejected", code: "unused" };
      },
    },
    validationProfiles: Object.freeze([
      Object.freeze({
        id: "strict",
        language,
        objective: "behavioral",
        formatterId: "biome",
        commandProfileIds: Object.freeze(["validate"]),
        negativeTestCommands: Object.freeze([]),
      }),
    ]),
    discoveryRoot: "packages/orchestrator",
  });
  const causal = createCausalWorkflow(config.causal);
  if (causal.status !== "accepted") throw new Error("fixture rejected");
  return {
    workflow: new EngineeringCoordinator(config, causal.workflow),
    destination,
    orchestrator: harness.orchestrator,
    physicalCalls: () => physicalCalls,
  };
}

function isDigest(value: unknown): value is ReturnType<typeof digestBytes> {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function prepareExample(
  fixture: ReturnType<typeof createFixture>,
  repository: Awaited<ReturnType<typeof repositoryContext>>,
  context: unknown,
) {
  return fixture.workflow.prepare({
    ...repository,
    context,
    changeDeclaration: createTestChangeDeclaration({
      requestDigest: repository.request.intentDigest,
      repositoryId: repository.repository.repositoryId,
      targets: Object.freeze([
        Object.freeze({ path: "src/example.ts", candidateDigest }),
      ]),
    }),
    targets: [
      {
        path: "src/example.ts",
        operations: [
          {
            kind: "replace",
            selector: {
              declarationKind: "function",
              name: "run",
              expectedNodeDigest: candidateDigest,
            },
            templateId: "function-template",
            nodeSource: "export function run(): boolean { return true; }",
          },
        ],
      },
    ],
    faultDeclarations: { declarations: [], negativeTests: [] },
    validationProfile: "strict",
    integrations: [],
  });
}
