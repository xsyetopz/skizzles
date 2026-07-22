// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createTaskWorktree,
  isTaskWorktreeReceipt,
  type TaskWorktreeApprovalAuthorityRequest,
} from "@skizzles/task-worktree";
import {
  createLocalRepositoryLeaseAuthority,
  type RepositoryLeaseAuthorityPort,
} from "@skizzles/workspace-transaction";
import { createCausalWorkflow } from "../../src/workflow/causal-workflow.ts";
import type {
  CausalWorkflow,
  CausalWorkflowConfig,
} from "../../src/workflow/contract.ts";
import { TaskWorktreeApprovalBridge } from "../../src/workflow/worktree/approval.ts";
import { createHarness, repositoryContext } from "../support.ts";
import { IsolatedDestination } from "./isolated-destination.ts";

const git = Bun.which("git");
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

interface FixtureOptions {
  readonly approvalBridge?: TaskWorktreeApprovalBridge;
  readonly crashStep?: string;
  readonly cleanupFault?: boolean;
  readonly drift?: boolean;
  readonly intervention?: boolean;
  readonly split?: boolean;
}

interface Fixture {
  readonly workflow: CausalWorkflow;
  readonly config: CausalWorkflowConfig;
  readonly destination: IsolatedDestination;
  readonly orchestrator: ReturnType<typeof createHarness>["orchestrator"];
  readonly repository: string;
  readonly worktreeParent: string;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  if (git === null) throw new Error("Git is required for workflow tests");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "skizzles-causal-worktree-")),
  );
  fixtureRoots.push(root);
  const repository = join(root, "repository");
  const worktreeParent = join(root, "worktrees");
  await mkdir(repository);
  await mkdir(worktreeParent);
  runGit(repository, ["init", "-b", "main"]);
  runGit(repository, ["config", "user.name", "Skizzles Test"]);
  runGit(repository, ["config", "user.email", "test@skizzles.invalid"]);
  await Bun.write(join(repository, "README.md"), "fixture\n");
  runGit(repository, ["add", "README.md"]);
  runGit(repository, ["commit", "-m", "chore: baseline"]);

  const harness = createHarness({
    ...(options.drift
      ? {
          targetRevalidate(input) {
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
              unchanged: false,
            };
          },
        }
      : {}),
  });
  const destination = new IsolatedDestination();
  const taskWorktreeApproval =
    options.approvalBridge ?? new TaskWorktreeApprovalBridge("causal-approval");
  const taskCreated = createTaskWorktree(
    Object.freeze({
      authorityId: "causal-task-worktree",
      approvalAuthority: Object.freeze({
        id: "causal-approval",
        authorize: (request: TaskWorktreeApprovalAuthorityRequest) =>
          taskWorktreeApproval.authorize(request),
      }),
      repositoryRoot: repository,
      worktreeParent,
      repositoryId: "repo-a",
      rootIdentity: "root-a",
      diffCeilings: Object.freeze({
        maxChangedFiles: options.split ? 1 : 8,
        maxAddedLines: 100,
        maxDeletedLines: 100,
        maxChangedBytes: 10_000,
      }),
      commitPolicy: Object.freeze({
        maxSubjectLength: 72,
        ownedPackagePaths: Object.freeze([
          Object.freeze({ path: "src/file.ts", scope: "fixture" }),
          Object.freeze({ path: "src/second.ts", scope: "fixture" }),
        ]),
      }),
      sandbox: Object.freeze({
        id: "causal-sandbox",
        attest: async (paths: readonly string[]) => {
          if (options.cleanupFault) {
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
              "orchestrator-cleanup-test",
              allocation,
            ]);
          }
          return Object.freeze({
            mechanism: "seatbelt" as const,
            writePaths: paths,
            deniesUndeclaredWrites: true as const,
            deniesSystemControl: true as const,
            readOnlyWorktree: true as const,
            networkDisabled: true as const,
            boundedProcessTree: true as const,
            evidence: "causal-fixture-attestation",
          });
        },
        execute: async (request: { readonly bindingDigest: string }) =>
          Object.freeze({
            exitCode: 0,
            stdoutDigest: "0".repeat(64),
            stderrDigest: "0".repeat(64),
            stdoutBytes: 0,
            stderrBytes: 0,
            bindingDigest: request.bindingDigest,
          }),
      }),
      sandboxWritePaths: Object.freeze([".skizzles-cache"]),
      dependencyResolver: Object.freeze({
        id: "causal-resolver",
        resolve: async (request: {
          readonly ecosystem: "npm";
          readonly name: string;
          readonly requestedRange: string;
        }) =>
          Object.freeze({
            ...request,
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
      commandProfiles: Object.freeze([
        Object.freeze({
          id: "validate",
          profile: "read-only" as const,
          executable: "git" as const,
          arguments: Object.freeze(["status"]),
          cwd: ".",
          timeoutMilliseconds: 10_000,
          maximumOutputBytes: 1024 * 1024,
          drainMilliseconds: 1000,
          signalGraceMilliseconds: 1000,
        }),
      ]),
    }),
  );
  if (taskCreated.status !== "created") {
    throw new Error("task worktree fixture rejected");
  }
  const leases: RepositoryLeaseAuthorityPort =
    createLocalRepositoryLeaseAuthority([
      { repositoryId: "repo-a", rootIdentity: "root-a", ownerId: "worker-a" },
    ]);
  const config: CausalWorkflowConfig = Object.freeze({
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
                expected: Object.freeze({ state: "missing" as const }),
              }),
            ),
          ),
        });
      },
    }),
    taskWorktree: taskCreated.taskWorktree,
    taskWorktreeApproval,
    transaction: Object.freeze({
      destination,
      leases,
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
  });
  const created = createCausalWorkflow(config);
  if (created.status !== "accepted") {
    throw new Error("valid causal workflow rejected");
  }
  return Object.freeze({
    workflow: created.workflow,
    config,
    destination,
    orchestrator: harness.orchestrator,
    repository,
    worktreeParent,
  });
}

async function prepare(
  fixture: Fixture,
  paths: readonly string[] = ["src/file.ts"],
) {
  const context = await repositoryContext(fixture.orchestrator);
  return await fixture.workflow.prepare({
    ...context,
    targets: paths.map((path, index) => ({
      path,
      operation: "write",
      candidateBytes: Array.from(
        new TextEncoder().encode(`export const value = ${index + 1};\n`),
      ),
    })),
    discoveryRoot: "packages/orchestrator",
    profileIds: ["validate"],
  });
}

describe("causal task-worktree workflow", () => {
  it("binds the authentic task receipt and executed profiles into review and approval diff", async () => {
    const fixture = await createFixture();
    const result = await prepare(fixture);
    if (result.status !== "awaiting-approval") {
      throw new Error(`workflow preparation failed: ${result.code}`);
    }
    expect(isTaskWorktreeReceipt(result.review.taskWorktreeReceipt)).toBe(true);
    expect(result.review.executedProfileIds).toEqual(["validate"]);
    const diff = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(result.review.approval.diffBytes),
      ),
    );
    expect(diff.taskWorktree).toEqual({
      receiptDigest: result.review.taskWorktreeReceipt.receiptDigest,
      candidateDigest: result.review.taskWorktreeReceipt.candidateDigest,
      declaredPathDigest: result.review.taskWorktreeReceipt.declaredPathDigest,
      commitMessageDigest:
        result.review.taskWorktreeReceipt.commitPlan.messageDigest,
      executedProfileIds: ["validate"],
    });
    await expect(
      fixture.workflow.reject({ review: result.review }),
    ).resolves.toMatchObject({
      status: "rejected",
      cleanup: { complete: true, taskWorktree: { taskId: "task-a" } },
    });
  });

  it("revalidates approval state and closes without committing on drift", async () => {
    const fixture = await createFixture({ drift: true });
    const prepared = await prepare(fixture);
    if (prepared.status !== "awaiting-approval") {
      throw new Error("workflow preparation failed");
    }
    const result = await fixture.workflow.approveAndPromote({
      review: prepared.review,
      token: "approve",
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "APPROVAL_DRIFTED",
      cleanup: { complete: true },
    });
    expect(
      gitOutput(fixture.repository, ["rev-list", "--all", "--count"]),
    ).toBe("1\n");
  });

  it("creates exactly one isolated commit, preserves it through uncertainty, then cleans after recovery", async () => {
    const fixture = await createFixture({ crashStep: "target-published" });
    const prepared = await prepare(fixture);
    if (prepared.status !== "awaiting-approval") {
      throw new Error("workflow preparation failed");
    }
    const promotion = await fixture.workflow.approveAndPromote({
      review: prepared.review,
      token: "approve",
    });
    if (promotion.status !== "recovery-required") {
      throw new Error("publication uncertainty was not retained");
    }
    const branch = prepared.review.taskWorktreeReceipt.branchName;
    expect(gitOutput(fixture.repository, ["rev-list", "--count", branch])).toBe(
      "2\n",
    );
    expect(worktreePaths(fixture.repository)).toHaveLength(2);
    expect(fixture.destination.currentText("src/file.ts")).toContain("value");
    const recovered = await fixture.workflow.recover({
      handle: promotion.handle,
    });
    expect(recovered).toMatchObject({
      status: "completed",
      cleanup: { complete: true, taskWorktree: { taskId: "task-a" } },
    });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(await readdir(fixture.worktreeParent)).toEqual([]);
  });

  it("cleans the exact uncommitted task session on rejection", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture);
    if (prepared.status !== "awaiting-approval") {
      throw new Error("workflow preparation failed");
    }
    const rejected = await fixture.workflow.reject({ review: prepared.review });
    expect(rejected).toMatchObject({
      status: "rejected",
      code: "APPROVAL_REJECTED",
      cleanup: { complete: true, targetReleased: true },
    });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
  });

  it("retries partial task-worktree cleanup without releasing the target early", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture);
    if (prepared.status !== "awaiting-approval") {
      throw new Error("workflow preparation failed");
    }
    const writableName = (await readdir(fixture.worktreeParent)).find((name) =>
      name.endsWith("-writable"),
    );
    if (writableName === undefined) throw new Error("writable root missing");
    const writableRoot = join(fixture.worktreeParent, writableName);
    const redirect = join(fixture.worktreeParent, "redirect");
    await rm(writableRoot, { recursive: true });
    await mkdir(redirect);
    await symlink(redirect, writableRoot);
    const rejected = await fixture.workflow.reject({ review: prepared.review });
    if (rejected.status !== "cleanup-pending") {
      throw new Error("partial cleanup was not retained");
    }
    expect(rejected.cleanup).toMatchObject({
      complete: false,
      targetReleased: false,
      taskWorktree: null,
    });
    await rm(writableRoot);
    await mkdir(writableRoot);
    await expect(
      fixture.workflow.retryCleanup({ handle: rejected.handle }),
    ).resolves.toMatchObject({
      status: "cleaned",
      cleanup: {
        complete: true,
        targetReleased: true,
        taskWorktree: { taskId: "task-a" },
      },
    });
  });

  it("returns a split plan before approval and leaves no task allocation", async () => {
    const fixture = await createFixture({ split: true });
    const result = await prepare(fixture, ["src/file.ts", "src/second.ts"]);
    expect(result).toMatchObject({
      status: "split-required",
      code: "TASK_SPLIT_REQUIRED",
      plan: { slices: [{ id: "slice-1" }, { id: "slice-2" }] },
      cleanup: { complete: true, targetReleased: true },
    });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(fixture.destination.captureCount).toBe(0);
  });

  it("owns failed-prepare cleanup and surfaces the split outcome after retry", async () => {
    const fixture = await createFixture({ split: true, cleanupFault: true });
    const result = await prepare(fixture, ["src/file.ts", "src/second.ts"]);
    if (result.status !== "cleanup-pending") {
      throw new Error(`expected cleanup-pending, received ${result.status}`);
    }
    expect(result.cleanup).toMatchObject({
      complete: false,
      targetReleased: false,
      taskWorktree: null,
      taskWorktreeCleanup: "pending",
    });
    const allocation = worktreePaths(fixture.repository).find(
      (path) => path !== fixture.repository,
    );
    if (allocation === undefined) throw new Error("allocation missing");
    runGit(fixture.repository, ["worktree", "unlock", allocation]);
    await expect(
      fixture.workflow.retryCleanup({ handle: result.handle }),
    ).resolves.toMatchObject({
      status: "split-required",
      code: "TASK_SPLIT_REQUIRED",
      plan: { slices: [{ id: "slice-1" }, { id: "slice-2" }] },
      cleanup: {
        complete: true,
        targetReleased: true,
        taskWorktree: null,
        taskWorktreeCleanup: "prepare-cleaned",
      },
    });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(await readdir(fixture.worktreeParent)).toEqual([]);
  });

  it("returns dependency intervention diagnostics before approval", async () => {
    const fixture = await createFixture({ intervention: true });
    const result = await prepare(fixture);
    expect(result).toMatchObject({
      status: "intervention-required",
      code: "TASK_INTERVENTION_REQUIRED",
      diagnostics: [{ kind: "dependency", outcome: "unavailable" }],
      cleanup: { complete: true, targetReleased: true },
    });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(fixture.destination.captureCount).toBe(0);
  });

  it("rejects hostile and lookalike task-worktree facades", async () => {
    const fixture = await createFixture();
    const fake = Object.freeze({
      prepare: fixture.config.taskWorktree.prepare,
      run: fixture.config.taskWorktree.run,
      revalidate: fixture.config.taskWorktree.revalidate,
      authorize: fixture.config.taskWorktree.authorize,
      commit: fixture.config.taskWorktree.commit,
      close: fixture.config.taskWorktree.close,
      retryCleanup: fixture.config.taskWorktree.retryCleanup,
    });
    expect(
      createCausalWorkflow(
        Object.freeze({ ...fixture.config, taskWorktree: fake }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_WORKFLOW_CONFIG" });
    expect(
      createCausalWorkflow(
        Object.freeze({
          ...fixture.config,
          taskWorktreeApproval: Object.freeze({
            authorityId: fixture.config.taskWorktreeApproval.authorityId,
            register: fixture.config.taskWorktreeApproval.register,
            authorize: fixture.config.taskWorktreeApproval.authorize,
          }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_WORKFLOW_CONFIG" });
    expect(
      createCausalWorkflow(
        Object.freeze({
          ...fixture.config,
          taskWorktreeApproval: new Proxy(
            fixture.config.taskWorktreeApproval,
            {},
          ),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_WORKFLOW_CONFIG" });
    expect(
      createCausalWorkflow(
        Object.freeze({
          ...fixture.config,
          taskWorktree: new Proxy(fixture.config.taskWorktree, {}),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_WORKFLOW_CONFIG" });
  });

  it("unregisters an unconsumed approval record before the same identity is reused", async () => {
    const bridge = new TaskWorktreeApprovalBridge("causal-approval");
    const first = await createFixture({ approvalBridge: bridge });
    const firstPrepared = await prepare(first);
    if (firstPrepared.status !== "awaiting-approval") {
      throw new Error("first workflow did not prepare");
    }
    expect(
      await first.workflow.reject({ review: firstPrepared.review }),
    ).toMatchObject({ status: "rejected" });
    const second = await createFixture({ approvalBridge: bridge });
    expect(await prepare(second)).toMatchObject({
      status: "awaiting-approval",
    });
  });
});

function worktreePaths(repository: string): readonly string[] {
  return gitOutput(repository, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
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

function gitOutput(cwd: string, arguments_: readonly string[]): string {
  const result = Bun.spawnSync([git ?? "git", ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
