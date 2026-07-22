import type { SourceEngineering } from "@skizzles/source-engineering";
import { createLocalRepositoryLeaseAuthority } from "@skizzles/workspace-transaction";
import { digestBytes, digestValue } from "../../../src/digest.ts";
import type { EngineeringWorkflowConfig } from "../../../src/engineering/contract.ts";
import { EngineeringCoordinator } from "../../../src/engineering/coordinator.ts";
import {
  snapshotArray,
  snapshotRecord,
} from "../../../src/engineering/snapshot.ts";
import { createCausalWorkflow } from "../../../src/workflow/causal-workflow.ts";
import { createHarness, type repositoryContext } from "../../support.ts";
import { IsolatedDestination } from "../../workflow/isolated-destination.ts";
import {
  createTestChangeAssurance,
  createTestChangeDeclaration,
} from "../assurance-fixture.ts";
import { createTestTaskWorktree } from "../worktree/fixture.ts";

export const candidate = new TextEncoder().encode(
  "export function run(): boolean { return true; }\n",
);
export const candidateDigest = digestBytes(candidate);
const fixtureCleanups: (() => void)[] = [];

export function cleanupFixtures(): void {
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
}

export function createFixture(
  options: {
    readonly pauseOnce?: boolean;
    readonly rejectVerification?: boolean;
    readonly language?: string;
    readonly targetPath?: string;
    readonly negativeEvidence?: boolean;
    readonly omitNegativeProfile?: boolean;
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
      observedNegativeTests: Object.freeze(
        options.negativeEvidence
          ? [
              Object.freeze({
                productionPath: targetPath,
                testPath: "test/example.test.ts",
                failureCodes: Object.freeze(["NEGATIVE_CASE"]),
              }),
            ]
          : [],
      ),
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
  const taskFixture = createTestTaskWorktree();
  fixtureCleanups.push(taskFixture.cleanup);
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
      taskWorktree: taskFixture.taskWorktree,
      taskWorktreeApproval: taskFixture.taskWorktreeApproval,
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
        negativeTestCommands: Object.freeze(
          options.negativeEvidence
            ? [
                Object.freeze({
                  profileId: "negative-test",
                  testPaths: Object.freeze(["test/example.test.ts"]),
                }),
              ]
            : [],
        ),
      }),
    ]),
    discoveryRoot: "packages/orchestrator",
  });
  const causal = createCausalWorkflow(config.causal);
  if (causal.status !== "accepted") throw new Error("fixture rejected");
  const causalWorkflow = options.omitNegativeProfile
    ? Object.freeze({
        ...causal.workflow,
        async prepare(input: unknown) {
          const result = await causal.workflow.prepare(input);
          if (result.status !== "awaiting-approval") return result;
          return Object.freeze({
            status: "awaiting-approval" as const,
            review: Object.freeze({
              ...result.review,
              executedProfileIds: Object.freeze(
                result.review.executedProfileIds.filter(
                  (profileId) => profileId !== "negative-test",
                ),
              ),
            }),
          });
        },
      })
    : causal.workflow;
  return {
    workflow: new EngineeringCoordinator(config, causalWorkflow),
    destination,
    orchestrator: harness.orchestrator,
    physicalCalls: () => physicalCalls,
  };
}

function isDigest(value: unknown): value is ReturnType<typeof digestBytes> {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function prepareExample(
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
