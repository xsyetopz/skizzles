import { createChangeDeclaration } from "@skizzles/change-assurance";
import { createLocalRepositoryLeaseAuthority } from "@skizzles/workspace-transaction";
import { digestValue } from "../../../src/digest.ts";
import type { ContextOperation } from "../../../src/engineering/context.ts";
import { createEngineeringWorkflow } from "../../../src/engineering/workflow.ts";
import { createHarness, repositoryContext } from "../../support.ts";
import { createTestWorkflowVerificationAuthority } from "../../verification-fixture.ts";
import { IsolatedDestination } from "../../workflow/isolated-destination.ts";
import {
  createTestChangeAssurance,
  createTestChangeDeclaration,
  createTestSecurityReview,
} from "../assurance-fixture.ts";
import {
  createTestTaskWorktree,
  type TestTaskWorktreeOptions,
} from "../worktree/fixture.ts";
import {
  candidateFor,
  digest,
  functionNameFor,
  replacementFor,
  secondTargetPath,
  targetPath,
} from "./data.ts";
import {
  createCompilerProject,
  createRealSourceEngineering,
} from "./support.ts";

export {
  candidate,
  digest,
  replacement,
  targetPath,
} from "./data.ts";
export interface SourceFixtureOptions extends TestTaskWorktreeOptions {
  readonly crashStep?: string;
  readonly driftAfterTargetRevalidations?: number;
  readonly negativeTestProfile?: boolean;
  readonly pauseOnce?: boolean;
  readonly advanceBarrier?: Promise<void>;
  readonly onAdvanceBlocked?: () => void;
}

export async function createFixture(options: SourceFixtureOptions = {}) {
  let targetRevalidations = 0;
  const driftAfterTargetRevalidations = options.driftAfterTargetRevalidations;
  const harness = createHarness({
    executionActions: 8,
    ...(driftAfterTargetRevalidations === undefined
      ? {}
      : {
          targetRevalidate(input) {
            targetRevalidations += 1;
            return {
              reservationId: input.reservationId,
              repositoryId: input.repositoryId,
              requestDigest: input.requestDigest,
              treeDigest: input.treeDigest,
              targets: input.targets,
              headDigest: input.headDigest,
              indexDigest: input.indexDigest,
              worktreeDigest: input.worktreeDigest,
              statusDigest: input.statusDigest,
              unchanged: targetRevalidations <= driftAfterTargetRevalidations,
            };
          },
        }),
  });
  const repository = await repositoryContext(harness.orchestrator);
  const targets = options.split
    ? Object.freeze([secondTargetPath, targetPath])
    : Object.freeze([targetPath]);
  const compiler = createCompilerProject(repository, targets);
  const taskFixture = createTestTaskWorktree(options);
  const sourceEngineering = createRealSourceEngineering(
    compiler.authority,
    targets,
    options,
  );
  const destination = new IsolatedDestination();
  const operations: ContextOperation[] = [];
  const changeAssurance = createTestChangeAssurance();
  const securityReview = createTestSecurityReview(changeAssurance);
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
      verificationAuthority: createTestWorkflowVerificationAuthority(),
      verificationProfiles: Object.freeze({
        originalTests: "verify-original-tests",
        mutation: "verify-mutation",
        property: "verify-property",
        coverage: "verify-coverage",
      }),
      transaction: Object.freeze({
        destination,
        leases: createLocalRepositoryLeaseAuthority([
          Object.freeze({
            repositoryId: "repo-a",
            rootIdentity: "root-a",
            ownerId: "worker-a",
          }),
        ]),
        ...(options.crashStep === undefined
          ? {}
          : {
              crashInjection: Object.freeze({
                async checkpoint(input: { readonly step: string }) {
                  return input.step === options.crashStep;
                },
              }),
            }),
      }),
      approvalContext: Object.freeze({
        taskId: "task-a",
        principalId: "maintainer-a",
        operation: "publish",
      }),
    }),
    sourceEngineering,
    changeAssurance,
    securityPolicyLinter: securityReview.linter,
    independentSecurityReview: securityReview.reviewer,
    contextBudget: Object.freeze({
      reserve(
        input: Parameters<
          import("../../../src/engineering/context.ts").ContextBudgetAuthorityPort["reserve"]
        >[0],
      ) {
        operations.push(input.operation);
        reservation += 1;
        if (options.pauseOnce && reservation === 2) {
          return Object.freeze({
            status: "paused" as const,
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
    taskRuntime: Object.freeze({
      timeoutMilliseconds: 25,
      interrupt(input: Readonly<Record<string, unknown>>): unknown {
        const material = Object.freeze({
          ...input,
          interrupted: true,
          quiescent: true,
        });
        return Object.freeze({
          ...material,
          receiptDigest: digestValue(material),
        });
      },
    }),
    validationProfiles: Object.freeze([
      Object.freeze({
        id: "strict",
        language: "typescript",
        objective: "behavioral",
        formatterId: "formatter",
        commandProfileIds: Object.freeze(["validate"]),
        negativeTestCommands: options.negativeTestProfile
          ? Object.freeze([
              Object.freeze({
                profileId: "negative-test",
                testPaths: Object.freeze([targetPath]),
              }),
            ])
          : Object.freeze([]),
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
    targets,
    taskFixture,
    cleanup: () => {
      compiler.cleanup();
      taskFixture.cleanup();
    },
  });
}

export type SourceFixture = Awaited<ReturnType<typeof createFixture>>;

export async function prepareSourceFixture(
  fixture: SourceFixture,
  options: Readonly<{ invalidAssurance?: boolean }> = {},
) {
  const described = await fixture.workflow.describe({
    ...fixture.repository,
    targets: fixture.targets,
    validationProfile: "strict",
  });
  if (described.status !== "described") return described;
  const operations = fixture.targets.map((path) => {
    const target = described.context.targets.find(
      (entry) => entry.path === path,
    );
    const declaration = target?.declarations.find(
      (entry) =>
        entry.declarationKind === "function" &&
        entry.name === functionNameFor(path),
    );
    if (declaration === undefined) {
      throw new Error(`described declaration missing for ${path}`);
    }
    return Object.freeze({ path, declaration });
  });
  return await fixture.workflow.prepare({
    ...fixture.repository,
    context: described.context,
    changeDeclaration: options.invalidAssurance
      ? invalidChangeDeclaration(fixture)
      : createTestChangeDeclaration({
          requestDigest: fixture.repository.request.intentDigest,
          repositoryId: fixture.repository.repository.repositoryId,
          targets: Object.freeze(
            fixture.targets.map((path) =>
              Object.freeze({
                path,
                candidateDigest: digest(candidateFor(path)),
              }),
            ),
          ),
        }),
    targets: operations.map(({ path, declaration }) => ({
      path,
      operations: [
        {
          kind: "replace",
          selector: {
            declarationKind: "function",
            name: functionNameFor(path),
            expectedNodeDigest: declaration.nodeDigest,
          },
          templateId: "typescript-function",
          nodeSource: replacementFor(path),
        },
      ],
    })),
    faultDeclarations: { declarations: [], negativeTests: [] },
    validationProfile: "strict",
    integrations: [],
  });
}

function invalidChangeDeclaration(fixture: SourceFixture) {
  const created = createChangeDeclaration(
    Object.freeze({
      requestDigest: fixture.repository.request.intentDigest,
      repositoryId: fixture.repository.repository.repositoryId,
      targets: Object.freeze(
        fixture.targets.map((path) =>
          Object.freeze({ path, operation: "write" as const }),
        ),
      ),
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
  if (created.status !== "created") {
    throw new Error("invalid assurance declaration fixture rejected");
  }
  return created.declaration;
}
