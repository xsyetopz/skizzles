import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createTaskWorktree,
  type SandboxAuthorityExecutionRequest,
  type TaskWorktree,
  type TaskWorktreeApprovalAuthorityRequest,
  type TaskWorktreeVerificationReport,
} from "@skizzles/task-worktree";
import { TaskWorktreeApprovalBridge } from "../../../src/workflow/worktree/approval.ts";

const git = Bun.which("git");
type SandboxVerificationObjective = NonNullable<
  SandboxAuthorityExecutionRequest["verificationObjective"]
>;

export interface TestTaskWorktreeOptions {
  readonly approvalBridge?: TaskWorktreeApprovalBridge;
  readonly cleanupFault?: boolean;
  readonly intervention?: boolean;
  readonly split?: boolean;
}

export function createTestTaskWorktree(
  options: TestTaskWorktreeOptions = {},
): Readonly<{
  taskWorktree: TaskWorktree;
  taskWorktreeApproval: TaskWorktreeApprovalBridge;
  readonly repository: string;
  readonly worktreeParent: string;
  mutateCandidate: (path: string) => void;
  restoreCandidate: (path: string) => void;
  unlockAllocatedWorktree: () => void;
  cleanup: () => void;
}> {
  if (git === null) throw new Error("Git is required for workflow tests");
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "skizzles-engineering-worktree-")),
  );
  const repository = join(root, "repository");
  const worktreeParent = join(root, "worktrees");
  const taskWorktreeApproval =
    options.approvalBridge ??
    new TaskWorktreeApprovalBridge("engineering-approval");
  let cleanupFaultInjected = false;
  mkdirSync(repository);
  mkdirSync(worktreeParent);
  runGit(repository, ["init", "-b", "main"]);
  runGit(repository, ["config", "user.name", "Skizzles Test"]);
  runGit(repository, ["config", "user.email", "test@skizzles.invalid"]);
  mkdirSync(join(repository, "test"));
  mkdirSync(join(repository, "spec"));
  writeFileSync(join(repository, "README.md"), "fixture\n");
  writeFileSync(join(repository, "test", "fixture.test.ts"), "export {};\n");
  writeFileSync(join(repository, "spec", "rules.md"), "normative\n");
  runGit(repository, [
    "add",
    "README.md",
    "test/fixture.test.ts",
    "spec/rules.md",
  ]);
  runGit(repository, ["commit", "-m", "chore: baseline"]);
  const created = createTaskWorktree(
    Object.freeze({
      authorityId: "engineering-task-worktree",
      approvalAuthority: Object.freeze({
        id: "engineering-approval",
        authorize: (request: TaskWorktreeApprovalAuthorityRequest) =>
          taskWorktreeApproval.authorize(request),
      }),
      repositoryRoot: repository,
      worktreeParent,
      repositoryId: "repo-a",
      rootIdentity: "root-a",
      protectedPaths: Object.freeze({
        policyId: "engineering-protected-paths",
        testRoots: Object.freeze(["test"]),
        specificationRoots: Object.freeze(["spec"]),
        authorize: async (request: {
          readonly requestDigestOfThisMaterial: string;
          readonly testPaths: readonly string[];
        }) =>
          Object.freeze({
            status: "authorized" as const,
            requestDigest: request.requestDigestOfThisMaterial,
            mode: "implementation" as const,
            authorizedTestPaths: Object.freeze([...request.testPaths]),
            authorizationDigest: `sha256:${"c".repeat(64)}` as const,
          }),
      }),
      diffCeilings: Object.freeze({
        maxChangedFiles: options.split ? 1 : 64,
        maxAddedLines: 10_000,
        maxDeletedLines: 10_000,
        maxChangedBytes: 2_000_000,
      }),
      commitPolicy: Object.freeze({
        maxSubjectLength: 72,
        ownedPackagePaths: Object.freeze([
          Object.freeze({ path: "src", scope: "fixture" }),
          Object.freeze({ path: "test", scope: "fixture" }),
        ]),
      }),
      sandbox: Object.freeze({
        id: "engineering-sandbox",
        attest: async (paths: readonly string[]) => {
          if (options.cleanupFault && !cleanupFaultInjected) {
            const allocation = worktreePaths(repository).find(
              (path) => path !== repository,
            );
            if (allocation === undefined) {
              throw new Error("task worktree allocation missing");
            }
            runGit(repository, [
              "worktree",
              "lock",
              "--reason",
              "engineering-cleanup-test",
              allocation,
            ]);
            cleanupFaultInjected = true;
          }
          return Object.freeze({
            mechanism: "container-user-namespace" as const,
            writePaths: paths,
            deniesUndeclaredWrites: true as const,
            deniesSystemControl: true as const,
            readOnlyWorktree: true as const,
            networkDisabled: true as const,
            boundedProcessTree: true as const,
            evidence: "engineering-fixture-attestation",
          });
        },
        execute: async (request: SandboxAuthorityExecutionRequest) => {
          if (request.verificationObjective !== undefined) {
            writeVerificationArtifact(
              request.writeRoot,
              request.verificationObjective,
            );
            return executionSuccess(request.bindingDigest);
          }
          const result = Bun.spawnSync(
            [request.command.executable, ...request.command.arguments],
            {
              cwd:
                request.command.cwd === "."
                  ? request.worktreeRoot
                  : join(request.worktreeRoot, request.command.cwd),
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const stdout = result.stdout.toString();
          const stderr = result.stderr.toString();
          return Object.freeze({
            exitCode: result.exitCode,
            stdoutDigest: digest(stdout),
            stderrDigest: digest(stderr),
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength(stderr),
            bindingDigest: request.bindingDigest,
          });
        },
      }),
      sandboxWritePaths: Object.freeze([".skizzles-cache"]),
      dependencyResolver: Object.freeze({
        id: "engineering-resolver",
        resolve: async () =>
          Object.freeze({
            ecosystem: "npm" as const,
            name: "unused",
            requestedRange: "1",
            resolvedVersion: options.intervention ? null : "1.0.0",
            registry: "fixture",
          }),
      }),
      dependencyRequests: Object.freeze(
        options.intervention
          ? [
              Object.freeze({
                ecosystem: "npm" as const,
                name: "fixture-package",
                requestedRange: "1",
              }),
            ]
          : [],
      ),
      commandProfiles: Object.freeze(
        ["validate", "negative-test"].map((id) =>
          Object.freeze({
            id,
            profile: "read-only" as const,
            executable: "git" as const,
            arguments: Object.freeze(["status"]),
            cwd: ".",
            timeoutMilliseconds: 10_000,
            maximumOutputBytes: 1024 * 1024,
            drainMilliseconds: 1000,
            signalGraceMilliseconds: 1000,
          }),
        ),
      ),
      verificationProfiles: Object.freeze(
        (
          [
            ["verify-original-tests", "original-tests", "baseline-tests"],
            ["verify-mutation", "mutation", "candidate"],
            ["verify-property", "property", "candidate"],
            ["verify-coverage", "coverage", "candidate"],
          ] as const
        ).map(([id, kind, view]) =>
          Object.freeze({
            id,
            kind,
            view,
            profile: "test" as const,
            executable: "bun" as const,
            arguments: Object.freeze(["test"]),
            cwd: ".",
            timeoutMilliseconds: 10_000,
            maximumOutputBytes: 1024 * 1024,
            drainMilliseconds: 1000,
            signalGraceMilliseconds: 1000,
            artifact: Object.freeze({
              schema: `skizzles.fixture/${kind}`,
              relativePath: `verification/${kind}.json`,
              maximumBytes: 1024 * 1024,
            }),
          }),
        ),
      ),
    }),
  );
  if (created.status !== "created") {
    rmSync(root, { force: true, recursive: true });
    throw new Error("engineering task-worktree fixture rejected");
  }
  return Object.freeze({
    taskWorktree: created.taskWorktree,
    taskWorktreeApproval,
    repository,
    worktreeParent,
    mutateCandidate: (path: string) => {
      const allocation = worktreePaths(repository).find(
        (entry) => entry !== repository,
      );
      if (allocation === undefined)
        throw new Error("task worktree allocation missing");
      appendFileSync(join(allocation, path), "\n// fixture candidate drift\n");
    },
    restoreCandidate: (path: string) => {
      const allocation = worktreePaths(repository).find(
        (entry) => entry !== repository,
      );
      if (allocation === undefined)
        throw new Error("task worktree allocation missing");
      const candidatePath = join(allocation, path);
      const marker = "\n// fixture candidate drift\n";
      const candidate = readFileSync(candidatePath, "utf8");
      if (!candidate.endsWith(marker)) {
        throw new Error("candidate drift marker restoration failed");
      }
      writeFileSync(candidatePath, candidate.slice(0, -marker.length));
    },
    unlockAllocatedWorktree: () => {
      const allocation = worktreePaths(repository).find(
        (path) => path !== repository,
      );
      if (allocation === undefined)
        throw new Error("task worktree allocation missing");
      runGit(repository, ["worktree", "unlock", allocation]);
    },
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  });
}

function writeVerificationArtifact(
  root: string,
  objective: SandboxVerificationObjective,
): void {
  const directory = join(root, "verification");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${objective.kind}.json`),
    JSON.stringify({
      schema: `skizzles.fixture/${objective.kind}`,
      result: verificationReport(objective),
    }),
  );
}

function verificationReport(
  objective: SandboxVerificationObjective,
): TaskWorktreeVerificationReport {
  if (objective.kind === "original-tests") {
    return {
      kind: objective.kind,
      outcome: "passed",
      passedCount: 1,
      failedCount: 0,
      testIds: ["fixture"],
      baselineTestManifestDigest: objective.baselineTestManifestDigest,
      productionOverlayDigest: objective.productionOverlayDigest,
      containerImageDigest: objective.containerImageDigest,
      containerEvidenceDigest: objective.containerEvidenceDigest,
    };
  }
  if (objective.kind === "mutation") {
    return {
      kind: objective.kind,
      outcome: "passed",
      inventoryDigest: objective.inventoryDigest,
      outcomes: objective.mutantIds.map((mutantId) => ({
        mutantId,
        outcome: "killed",
        evidenceDigest: `sha256:${"d".repeat(64)}`,
      })),
    };
  }
  if (objective.kind === "property") {
    return {
      kind: objective.kind,
      outcome: "passed",
      seedScheduleDigest: objective.seedScheduleDigest,
      requiredCaseCount: objective.requiredCaseCount,
      extremeVectorInventoryDigest: objective.extremeVectorInventoryDigest,
      properties: [
        {
          propertyId: "fixture-property",
          nodeIds: objective.nodeIds,
          branchIds: objective.branchIds,
          completed: true,
          executedCases: objective.requiredCaseCount,
          executedRandomCases: objective.requiredRandomFuzzCaseCount,
          executedExtremeCases: objective.requiredExtremeVectorCount,
          executedExtremeVectorDigests: objective.requiredExtremeVectorDigests,
          counterexampleDigest: null,
        },
      ],
    };
  }
  return {
    kind: objective.kind,
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
}

function executionSuccess(bindingDigest: string) {
  return Object.freeze({
    exitCode: 0,
    stdoutDigest: digest(""),
    stderrDigest: digest(""),
    stdoutBytes: 0,
    stderrBytes: 0,
    bindingDigest,
  });
}

function runGit(cwd: string, arguments_: readonly string[]): void {
  const result = Bun.spawnSync([git ?? "git", ...arguments_], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function worktreePaths(repository: string): readonly string[] {
  return gitOutput(repository, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function gitOutput(cwd: string, arguments_: readonly string[]): string {
  const result = Bun.spawnSync([git ?? "git", ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
