import { afterEach, describe, expect, it } from "bun:test";
import { createCausalWorkflow } from "../../../src/workflow/causal/create.ts";
import { TaskWorktreeApprovalBridge } from "../../../src/workflow/worktree/approval.ts";
import {
  createFixture,
  prepareSourceFixture,
  type SourceFixture,
} from "./fixture.ts";

const fixtures: SourceFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function fixture(
  options: Parameters<typeof createFixture>[0] = {},
): Promise<SourceFixture> {
  const created = await createFixture(options);
  fixtures.push(created);
  return created;
}

async function checkpointFor(fixture: SourceFixture, id: string) {
  const created = await fixture.orchestrator.createTaskCheckpoint({
    id,
    taskId: "task-a",
    rootIdentity: "root-a",
    request: fixture.repository.request,
    repository: fixture.repository.repository,
  });
  if (created.status !== "accepted") {
    throw new Error(`task checkpoint failed: ${created.code}`);
  }
  return created.checkpoint;
}

async function taskContextFor(fixture: SourceFixture) {
  const described = await fixture.workflow.describe({
    ...fixture.repository,
    targets: ["test/value.test.ts"],
    validationProfile: "strict",
  });
  if (described.status !== "described") {
    throw new Error(`describe failed: ${described.code}`);
  }
  return described.taskContext;
}

function deferred<Value>() {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((fulfilled) => {
    resolve = fulfilled;
  });
  return Object.freeze({
    promise,
    resolve(value: Value) {
      if (resolve === undefined) throw new Error("deferred resolver missing");
      resolve(value);
    },
  });
}

describe("real engineering workflow publication", () => {
  it("binds all authentic task verification receipts before review and cleans on rejection", async () => {
    const preparedFixture = await fixture();
    const prepared = await prepareSourceFixture(preparedFixture);
    if (prepared.status !== "awaiting-approval") {
      throw new Error(`prepare failed: ${prepared.code}`);
    }
    expect(prepared.review.taskVerificationReceipts).toHaveLength(4);
    expect(
      prepared.review.taskVerificationReceipts.map(
        ({ profileKind }) => profileKind,
      ),
    ).toEqual(["original-tests", "mutation", "property", "coverage"]);
    expect(prepared.review.taskWorktreeReceipt.taskEpochDigest).toBeTruthy();
    await expect(
      preparedFixture.workflow.reject({ review: prepared.review }),
    ).resolves.toMatchObject({
      status: "rejected",
      cleanup: { complete: true, taskWorktree: { taskId: "task-a" } },
    });
  });

  it("revalidates the approved candidate and rejects publication drift", async () => {
    const preparedFixture = await fixture({
      driftAfterTargetRevalidations: 1,
    });
    const prepared = await prepareSourceFixture(preparedFixture);
    if (prepared.status !== "awaiting-approval") {
      throw new Error(`prepare failed: ${prepared.code}`);
    }
    await expect(
      preparedFixture.workflow.approveAndPromote({
        review: prepared.review,
        token: "approve",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "APPROVAL_DRIFTED",
      cleanup: { complete: true },
    });
  });

  it("preserves an authentic task commit through publication uncertainty and recovers it", async () => {
    const preparedFixture = await fixture({ crashStep: "target-published" });
    const prepared = await prepareSourceFixture(preparedFixture);
    if (prepared.status !== "awaiting-approval") {
      throw new Error(`prepare failed: ${prepared.code}`);
    }
    const promotion = await preparedFixture.workflow.approveAndPromote({
      review: prepared.review,
      token: "approve",
    });
    if (promotion.status !== "recovery-required") {
      throw new Error(
        `expected recovery-required, received ${promotion.status}`,
      );
    }
    expect(
      preparedFixture.destination.currentText("test/value.test.ts"),
    ).toContain("return 2");
    await expect(
      preparedFixture.workflow.recover({ handle: promotion.handle }),
    ).resolves.toMatchObject({
      status: "completed",
      cleanup: { complete: true, taskWorktree: { taskId: "task-a" } },
    });
  });

  it("returns dependency intervention before publication", async () => {
    const preparedFixture = await fixture({ intervention: true });
    await expect(prepareSourceFixture(preparedFixture)).resolves.toMatchObject({
      status: "intervention-required",
      code: "TASK_INTERVENTION_REQUIRED",
      diagnostics: [{ kind: "dependency", outcome: "mismatch" }],
      cleanup: { complete: true, targetReleased: true },
    });
    expect(
      preparedFixture.destination.currentText("test/value.test.ts"),
    ).toBeUndefined();
  }, 30_000);

  it("returns an authentic split plan when two independently valid source changes exceed the task ceiling", async () => {
    const preparedFixture = await fixture({ split: true });
    await expect(prepareSourceFixture(preparedFixture)).resolves.toMatchObject({
      status: "split-required",
      code: "TASK_SPLIT_REQUIRED",
      plan: { slices: [{ id: "slice-1" }, { id: "slice-2" }] },
      cleanup: { complete: true, targetReleased: true },
    });
  }, 30_000);

  it("retries failed split cleanup after restoring the injected task worktree lock", async () => {
    const preparedFixture = await fixture({
      cleanupFault: true,
      split: true,
    });
    const prepared = await prepareSourceFixture(preparedFixture);
    if (prepared.status !== "cleanup-pending") {
      throw new Error(`expected cleanup-pending, received ${prepared.status}`);
    }
    expect(prepared.cleanup).toMatchObject({
      complete: false,
      targetReleased: false,
      taskWorktree: null,
      taskWorktreeCleanup: "pending",
    });
    preparedFixture.taskFixture.unlockAllocatedWorktree();
    await expect(
      preparedFixture.workflow.retryCleanup({ handle: prepared.handle }),
    ).resolves.toMatchObject({
      status: "split-required",
      code: "TASK_SPLIT_REQUIRED",
      plan: { slices: [{ id: "slice-1" }, { id: "slice-2" }] },
      cleanup: { complete: true, targetReleased: true },
    });
  }, 30_000);

  it("halts rejected assurance before task preparation or publication", async () => {
    const preparedFixture = await fixture();
    await expect(
      prepareSourceFixture(preparedFixture, { invalidAssurance: true }),
    ).resolves.toEqual({
      status: "rejected",
      code: "CHANGE_ASSURANCE_REJECTED",
      cleanup: null,
    });
    expect(
      preparedFixture.destination.currentText("test/value.test.ts"),
    ).toBeUndefined();
  }, 15_000);

  it("resumes a paused authentic engineering workflow only once", async () => {
    const preparedFixture = await fixture({ pauseOnce: true });
    const paused = await prepareSourceFixture(preparedFixture);
    if (paused.status !== "paused") {
      throw new Error(`expected paused, received ${paused.status}`);
    }
    const resumed = await preparedFixture.workflow.continue({
      continuation: paused.continuation,
    });
    expect(resumed.status).toBe("awaiting-approval");
    await expect(
      preparedFixture.workflow.continue({ continuation: paused.continuation }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });
    if (resumed.status === "awaiting-approval") {
      await preparedFixture.workflow.reject({ review: resumed.review });
    }
  }, 15_000);

  it("cancels an abandoned paused continuation and rejects its replay", async () => {
    const preparedFixture = await fixture({ pauseOnce: true });
    const paused = await prepareSourceFixture(preparedFixture);
    if (paused.status !== "paused") {
      throw new Error(`expected paused, received ${paused.status}`);
    }
    await expect(
      preparedFixture.workflow.cancelContinuation({
        continuation: paused.continuation,
      }),
    ).resolves.toEqual({ status: "cancelled" });
    await expect(
      preparedFixture.workflow.cancelContinuation({
        continuation: paused.continuation,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });
  }, 15_000);

  it("resets an explicitly rejected real review into a fresh task context", async () => {
    const preparedFixture = await fixture();
    const context = await taskContextFor(preparedFixture);
    await checkpointFor(preparedFixture, "rejected-reset");
    const prepared = await prepareSourceFixture(preparedFixture);
    if (prepared.status !== "awaiting-approval") {
      throw new Error(`prepare failed: ${prepared.code}`);
    }
    await preparedFixture.workflow.reject({ review: prepared.review });
    await expect(
      preparedFixture.workflow.resetContext({
        context,
        checkpointId: "rejected-reset",
        reason: "context-renewal",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      receipt: { publicationOutcome: "not-published" },
    });
  }, 30_000);

  it("records committed truth when a real promoted review resets its task context", async () => {
    const preparedFixture = await fixture();
    const context = await taskContextFor(preparedFixture);
    await checkpointFor(preparedFixture, "committed-reset");
    const prepared = await prepareSourceFixture(preparedFixture);
    if (prepared.status !== "awaiting-approval") {
      throw new Error(`prepare failed: ${prepared.code}`);
    }
    await expect(
      preparedFixture.workflow.approveAndPromote({
        review: prepared.review,
        token: "approve",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      preparedFixture.workflow.resetContext({
        context,
        checkpointId: "committed-reset",
        reason: "context-renewal",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      receipt: { publicationOutcome: "committed" },
    });
  }, 30_000);

  it("holds context reset at interrupt until a real in-flight source advance releases admission", async () => {
    const advance = deferred<void>();
    const entered = deferred<void>();
    const preparedFixture = await fixture({
      advanceBarrier: advance.promise,
      onAdvanceBlocked: () => entered.resolve(),
    });
    const context = await taskContextFor(preparedFixture);
    await checkpointFor(preparedFixture, "in-flight-reset");
    const preparing = prepareSourceFixture(preparedFixture);
    await entered.promise;
    const reset = await preparedFixture.workflow.resetContext({
      context,
      checkpointId: "in-flight-reset",
      reason: "context-renewal",
    });
    if (reset.status !== "reset-pending") {
      throw new Error(`expected reset-pending, received ${reset.status}`);
    }
    expect(reset).toMatchObject({
      stage: "interrupt",
      code: "INTERRUPT_UNCONFIRMED",
    });
    await expect(
      preparedFixture.workflow.describe({
        ...preparedFixture.repository,
        targets: ["test/value.test.ts"],
        validationProfile: "strict",
      }),
    ).resolves.toEqual({ status: "rejected", code: "TASK_CONTEXT_STALE" });
    advance.resolve();
    await expect(preparing).resolves.toMatchObject({
      status: "rejected",
      code: "TASK_CONTEXT_STALE",
    });
    await expect(
      preparedFixture.workflow.resumeContextReset({ handle: reset.handle }),
    ).resolves.toMatchObject({ status: "ready" });
  }, 30_000);

  it("rejects method-copy task-worktree and approval bridge lookalikes", async () => {
    const preparedFixture = await fixture();
    const causal = preparedFixture.config.causal;
    const fakeTaskWorktree = Object.freeze({
      prepare: causal.taskWorktree.prepare,
      run: causal.taskWorktree.run,
      revalidate: causal.taskWorktree.revalidate,
      authorize: causal.taskWorktree.authorize,
      commit: causal.taskWorktree.commit,
      close: causal.taskWorktree.close,
      retryCleanup: causal.taskWorktree.retryCleanup,
    });
    expect(
      createCausalWorkflow(
        Object.freeze({ ...causal, taskWorktree: fakeTaskWorktree }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_WORKFLOW_CONFIG" });
    expect(
      createCausalWorkflow(
        Object.freeze({
          ...causal,
          taskWorktreeApproval: Object.freeze({
            authorityId: causal.taskWorktreeApproval.authorityId,
            register: causal.taskWorktreeApproval.register,
            authorize: causal.taskWorktreeApproval.authorize,
          }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_WORKFLOW_CONFIG" });
  });

  it("unregisters rejected task approval before the identity is reused", async () => {
    const bridge = new TaskWorktreeApprovalBridge("engineering-approval");
    const first = await fixture({ approvalBridge: bridge });
    const firstPrepared = await prepareSourceFixture(first);
    if (firstPrepared.status !== "awaiting-approval") {
      throw new Error(`first prepare failed: ${firstPrepared.code}`);
    }
    await expect(
      first.workflow.reject({ review: firstPrepared.review }),
    ).resolves.toMatchObject({
      status: "rejected",
    });
    first.cleanup();
    const second = await fixture({ approvalBridge: bridge });
    const secondPrepared = await prepareSourceFixture(second);
    if (secondPrepared.status !== "awaiting-approval") {
      throw new Error(
        `second prepare failed: ${JSON.stringify(secondPrepared)}`,
      );
    }
  }, 15_000);
});
