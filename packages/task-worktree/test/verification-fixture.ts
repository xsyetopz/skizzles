import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTaskWorktree,
  digestTaskWorktreeBytes,
  digestTaskWorktreeValue,
  type SandboxAuthorityExecutionRequest,
  type TaskWorktreeProtectedPathAuthorizationRequest,
} from "../src/index.ts";
import {
  createFixture,
  type Fixture,
  policyConfig,
  runGit,
} from "./lifecycle/support.ts";

export async function protectedFixture(): Promise<Fixture> {
  const fixture = await createFixture();
  await mkdir(join(fixture.repository, "src"));
  await mkdir(join(fixture.repository, "test"));
  await writeFile(
    join(fixture.repository, "src/value.ts"),
    "baseline production\n",
  );
  await writeFile(
    join(fixture.repository, "test/value.test.ts"),
    "baseline test\n",
  );
  await writeFile(join(fixture.repository, "spec/rules.md"), "normative\n");
  runGit(fixture.repository, ["add", "src", "test", "spec"]);
  runGit(fixture.repository, ["commit", "-m", "test: protected baseline"]);
  return fixture;
}

export function createProtectedAuthority(
  fixture: Fixture,
  mode: "design" | "implementation",
  authorize?: (
    request: TaskWorktreeProtectedPathAuthorizationRequest,
  ) => unknown,
  verification = false,
) {
  const config = protectedConfig(fixture, mode, authorize, verification);
  const created = createTaskWorktree(config);
  if (created.status !== "created") throw new Error("authority rejected");
  return created.taskWorktree;
}

export function protectedConfig(
  fixture: Fixture,
  mode: "design" | "implementation",
  authorize?: (
    request: TaskWorktreeProtectedPathAuthorizationRequest,
  ) => unknown,
  verification = false,
) {
  const base = policyConfig();
  return Object.freeze({
    authorityId: `protected-${mode}`,
    repositoryRoot: fixture.repository,
    worktreeParent: fixture.worktreeParent,
    repositoryId: "repo-a",
    rootIdentity: "root-a",
    ...base,
    protectedPaths: Object.freeze({
      policyId: "protected-policy",
      testRoots: Object.freeze(["test"]),
      specificationRoots: Object.freeze(["spec"]),
      authorize:
        authorize ??
        ((request: TaskWorktreeProtectedPathAuthorizationRequest) =>
          Object.freeze({
            status: "authorized" as const,
            requestDigest: request.requestDigestOfThisMaterial,
            mode,
            authorizedTestPaths: request.testPaths,
            authorizationDigest: digestTaskWorktreeValue("authorization"),
          })),
    }),
    verificationProfiles: verificationProfiles(verification),
    sandbox: verification ? verificationSandbox() : base.sandbox,
  });
}

export function verificationObjective(
  kind: "coverage" | "original-tests" | "property",
) {
  const structuralReceiptDigest = digestTaskWorktreeValue("structural");
  const requiredExtremeVectorDigests = Object.freeze([
    digestTaskWorktreeValue("extreme-a"),
    digestTaskWorktreeValue("extreme-b"),
  ]);
  if (kind === "original-tests")
    return Object.freeze({
      kind,
      structuralReceiptDigest,
      containerImageDigest: digestTaskWorktreeValue("container-image"),
    });
  if (kind === "property")
    return Object.freeze({
      kind,
      structuralReceiptDigest,
      seedScheduleDigest: digestTaskWorktreeValue("property-seed"),
      requiredRandomFuzzCaseCount: 128,
      requiredExtremeVectorCount: 2,
      requiredCaseCount: 130,
      requiredExtremeVectorDigests,
      extremeVectorInventoryDigest: digestTaskWorktreeValue(
        requiredExtremeVectorDigests,
      ),
      nodeIds: Object.freeze([digestTaskWorktreeValue("node-a")]),
      branchIds: Object.freeze([digestTaskWorktreeValue("branch-a")]),
    });
  return Object.freeze({
    kind,
    structuralReceiptDigest,
    modifiedNodes: Object.freeze([
      Object.freeze({
        nodeId: digestTaskWorktreeValue("node-a"),
        lineIds: Object.freeze([
          digestTaskWorktreeValue("line-a"),
          digestTaskWorktreeValue("line-b"),
        ]),
        branchIds: Object.freeze([digestTaskWorktreeValue("branch-a")]),
      }),
    ]),
    thresholds: Object.freeze({
      minimumNodeHits: 2,
      minimumLineHits: 2,
      minimumBranchHits: 2,
    }),
  });
}

function verificationProfiles(enabled: boolean) {
  if (!enabled) return Object.freeze([]);
  const common = Object.freeze({
    profile: "test" as const,
    executable: "bun" as const,
    arguments: Object.freeze(["test"]),
    cwd: ".",
    timeoutMilliseconds: 10_000,
    maximumOutputBytes: 1024 * 1024,
    drainMilliseconds: 1000,
    signalGraceMilliseconds: 1000,
  });
  return Object.freeze([
    Object.freeze({
      id: "original-tests",
      kind: "original-tests" as const,
      view: "baseline-tests" as const,
      ...common,
      artifact: Object.freeze({
        schema: "fixture.original-tests",
        relativePath: "verification/original.json",
        maximumBytes: 4096,
      }),
    }),
    Object.freeze({
      id: "candidate-tests",
      kind: "property" as const,
      view: "candidate" as const,
      ...common,
      artifact: Object.freeze({
        schema: "fixture.candidate-tests",
        relativePath: "verification/candidate.json",
        maximumBytes: 4096,
      }),
    }),
    Object.freeze({
      id: "coverage",
      kind: "coverage" as const,
      view: "candidate" as const,
      ...common,
      artifact: Object.freeze({
        schema: "fixture.coverage",
        relativePath: "verification/coverage.json",
        maximumBytes: 4096,
      }),
    }),
  ]);
}

function verificationSandbox() {
  return Object.freeze({
    id: "verification-sandbox",
    attest: async (paths: readonly string[]) =>
      Object.freeze({
        mechanism: "container-user-namespace" as const,
        writePaths: paths,
        deniesUndeclaredWrites: true as const,
        deniesSystemControl: true as const,
        readOnlyWorktree: true as const,
        networkDisabled: true as const,
        boundedProcessTree: true as const,
        evidence: "fixture-verification",
      }),
    execute: async (request: SandboxAuthorityExecutionRequest) => {
      const objective = request.verificationObjective;
      if (objective === undefined) throw new Error("missing objective");
      if (objective.kind === "mutation")
        throw new Error("unsupported fixture objective");
      const baseline = request.worktreeRoot.endsWith("-baseline-tests");
      const production = await readFile(
        join(request.worktreeRoot, "src/value.ts"),
        "utf8",
      );
      const test = await readFile(
        join(request.worktreeRoot, "test/value.test.ts"),
        "utf8",
      );
      if (production !== "candidate production\n")
        throw new Error("wrong production view");
      if (test !== (baseline ? "baseline test\n" : "candidate test\n"))
        throw new Error("wrong protected test view");
      const name =
        objective.kind === "original-tests"
          ? "original"
          : objective.kind === "property"
            ? "candidate"
            : "coverage";
      const schema =
        objective.kind === "original-tests"
          ? "fixture.original-tests"
          : objective.kind === "property"
            ? "fixture.candidate-tests"
            : "fixture.coverage";
      const result =
        objective.kind === "original-tests"
          ? {
              kind: "original-tests",
              outcome: "passed",
              passedCount: 2,
              failedCount: 0,
              testIds: ["test-a", "test-b"],
              baselineTestManifestDigest: objective.baselineTestManifestDigest,
              productionOverlayDigest: objective.productionOverlayDigest,
              containerImageDigest: objective.containerImageDigest,
              containerEvidenceDigest: objective.containerEvidenceDigest,
            }
          : objective.kind === "property"
            ? {
                kind: "property",
                outcome: "passed",
                seedScheduleDigest: objective.seedScheduleDigest,
                requiredCaseCount: objective.requiredCaseCount,
                extremeVectorInventoryDigest:
                  objective.extremeVectorInventoryDigest,
                properties: [
                  {
                    propertyId: "property-a",
                    nodeIds: objective.nodeIds,
                    branchIds: objective.branchIds,
                    completed: true,
                    executedCases: objective.requiredCaseCount,
                    executedRandomCases: objective.requiredRandomFuzzCaseCount,
                    executedExtremeCases:
                      objective.requiredExtremeVectorDigests.length,
                    executedExtremeVectorDigests:
                      objective.requiredExtremeVectorDigests,
                    counterexampleDigest: null,
                  },
                ],
              }
            : {
                kind: "coverage",
                outcome: "passed",
                nodes: objective.modifiedNodes.map((node) => ({
                  nodeId: node.nodeId,
                  hits: objective.thresholds.minimumNodeHits,
                  lines: node.lineIds.map((lineId) => ({
                    lineId,
                    hits: objective.thresholds.minimumLineHits,
                  })),
                  branches: node.branchIds.map((branchId) => ({
                    branchId,
                    hits: objective.thresholds.minimumBranchHits,
                  })),
                })),
              };
      await writeFile(
        join(request.writeRoot, `verification/${name}.json`),
        JSON.stringify({ schema, result }),
      );
      return Object.freeze({
        bindingDigest: request.bindingDigest,
        exitCode: 0,
        stdoutDigest: "0".repeat(64),
        stderrDigest: "0".repeat(64),
        stdoutBytes: 0,
        stderrBytes: 0,
      });
    },
  });
}

export function declaration(
  path: string,
  baseline: string | null,
  candidate: string,
  epoch = "epoch-1",
) {
  return Object.freeze({
    taskId: "protected-task",
    taskEpochDigest: digestTaskWorktreeValue(epoch),
    requestDigest: digestTaskWorktreeValue("request"),
    repositoryId: "repo-a",
    rootIdentity: "root-a",
    treeDigest: digestTaskWorktreeValue("tree"),
    baselineDigest: digestTaskWorktreeValue("baseline"),
    changes: Object.freeze([
      Object.freeze({
        path,
        operation: "write" as const,
        baselineDigest:
          baseline === null
            ? null
            : digestTaskWorktreeBytes(new TextEncoder().encode(baseline)),
        candidateBytes: Object.freeze([...new TextEncoder().encode(candidate)]),
      }),
    ]),
  });
}

export function multiDeclaration() {
  const source = declaration(
    "src/value.ts",
    "baseline production\n",
    "candidate production\n",
  );
  const test = declaration(
    "test/value.test.ts",
    "baseline test\n",
    "candidate test\n",
  );
  const sourceChange = source.changes[0];
  const testChange = test.changes[0];
  if (sourceChange === undefined || testChange === undefined)
    throw new Error("missing verification fixture changes");
  return Object.freeze({
    ...source,
    changes: Object.freeze([sourceChange, testChange]),
  });
}
