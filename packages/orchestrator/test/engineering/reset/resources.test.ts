import { describe, expect, it } from "bun:test";
import { digestValue } from "../../../src/digest.ts";
import { ContinuationLedger } from "../../../src/engineering/continuation.ts";
import { TaskEpochResources } from "../../../src/engineering/reset/resources.ts";
import type { PreparationState } from "../../../src/engineering/state.ts";
import type {
  CausalWorkflow,
  WorkflowCleanupReceipt,
  WorkflowRejectionResult,
} from "../../../src/workflow/contract.ts";

describe("task epoch resource settlement", () => {
  it("owns cleanup handles returned before any review exists", async () => {
    const taskEpochDigest = digestValue("pre-review-epoch");
    const handle = Object.freeze({ workflowId: "pre-review-cleanup" });
    let rejects = 0;
    let retries = 0;
    const resources = createResources(
      causal({
        reject: async () => {
          rejects += 1;
          return { status: "rejected", code: "WORKFLOW_STALE", cleanup: null };
        },
        retryCleanup: async () => {
          retries += 1;
          return {
            status: "cleaned",
            cleanup: cleanup(true, 2),
            publication: null,
            recovery: null,
          };
        },
      }),
    );
    resources.recordPreReviewOutcome(taskEpochDigest, {
      status: "cleanup-pending",
      code: "CLEANUP_FAILED",
      handle,
      cleanup: cleanup(false, 1),
    });
    expect(resources.epochForHandle(handle)).toBe(taskEpochDigest);
    await expect(resources.settle(taskEpochDigest)).resolves.toMatchObject({
      status: "settled",
      publicationOutcome: "not-published",
    });
    expect(rejects).toBe(0);
    expect(retries).toBe(1);
  });

  it("owns recovery handles returned before any review exists", async () => {
    const taskEpochDigest = digestValue("pre-review-recovery-epoch");
    const handle = Object.freeze({
      workflowId: "pre-review-recovery",
      recoveryDigest: "recovery-digest",
    });
    let recoveries = 0;
    const resources = createResources(
      causal({
        recover: async () => {
          recoveries += 1;
          return {
            status: "recovered-without-publication",
            recovery: { ok: true, status: "recovered-old" },
            cleanup: cleanup(true, 1),
          };
        },
      }),
    );
    resources.recordPreReviewOutcome(taskEpochDigest, {
      status: "recovery-required",
      code: "PUBLICATION_UNCERTAIN",
      handle,
    });
    expect(resources.epochForHandle(handle)).toBe(taskEpochDigest);
    await expect(resources.settle(taskEpochDigest)).resolves.toMatchObject({
      status: "settled",
      publicationOutcome: "recovered-old",
    });
    expect(recoveries).toBe(1);
  });

  it("retries an owned cleanup handle before rejecting its review again", async () => {
    const record = await authenticReview();
    let rejects = 0;
    let retries = 0;
    const firstHandle = Object.freeze({ workflowId: "phase2-review" });
    const secondHandle = Object.freeze({ workflowId: "phase2-review" });
    const resources = createResources(
      causal({
        reject: async () => {
          rejects += 1;
          return {
            status: "cleanup-pending",
            code: "CLEANUP_FAILED",
            handle: firstHandle,
            cleanup: cleanup(false, 1),
          };
        },
        retryCleanup: async () => {
          retries += 1;
          if (retries === 1) {
            return {
              status: "cleanup-pending",
              code: "CLEANUP_FAILED",
              handle: secondHandle,
              cleanup: cleanup(false, 2),
            };
          }
          return {
            status: "cleaned",
            cleanup: cleanup(true, 3),
            publication: null,
            recovery: null,
          };
        },
      }),
    );
    trackReview(resources, record);
    await expect(resources.settle(record.taskEpochDigest)).resolves.toEqual({
      status: "pending",
      stage: "cleanup",
    });
    await expect(resources.settle(record.taskEpochDigest)).resolves.toEqual({
      status: "pending",
      stage: "cleanup",
    });
    await expect(
      resources.settle(record.taskEpochDigest),
    ).resolves.toMatchObject({
      status: "settled",
      publicationOutcome: "not-published",
    });
    expect(rejects).toBe(1);
    expect(retries).toBe(2);
  });

  it("resumes recovery before touching a tracked review", async () => {
    const record = await authenticReview();
    let rejects = 0;
    let recoveries = 0;
    const recoveryHandle = Object.freeze({
      workflowId: "phase2-review",
      recoveryDigest: "recovery-digest",
    });
    const resources = createResources(
      causal({
        reject: async () => {
          rejects += 1;
          return { status: "rejected", code: "WORKFLOW_BUSY", cleanup: null };
        },
        recover: async () => {
          recoveries += 1;
          return {
            status: "recovered-without-publication",
            recovery: { ok: true, status: "recovered-old" },
            cleanup: cleanup(true, 1),
          };
        },
      }),
    );
    trackReview(resources, record);
    recordReviewOutcome(resources, record, {
      status: "recovery-required",
      code: "PUBLICATION_UNCERTAIN",
      handle: recoveryHandle,
    });
    await expect(
      resources.settle(record.taskEpochDigest),
    ).resolves.toMatchObject({
      status: "settled",
      publicationOutcome: "recovered-old",
    });
    expect(rejects).toBe(0);
    expect(recoveries).toBe(1);
  });

  it("preserves committed publication truth returned by cleanup retry", async () => {
    const record = await authenticReview();
    const handle = Object.freeze({ workflowId: "phase2-review" });
    const resources = createResources(
      causal({
        retryCleanup: async () => ({
          status: "cleaned",
          cleanup: cleanup(true, 2),
          publication: {
            ok: true,
            status: "committed",
            transactionId: "transaction-a",
            requestDigest: "request-a",
            targetSetDigest: "targets-a",
            baselineDigest: "baseline-a",
            publishedTargets: 1,
          },
          recovery: null,
        }),
      }),
    );
    trackReview(resources, record);
    recordReviewOutcome(resources, record, {
      status: "cleanup-pending",
      code: "CLEANUP_FAILED",
      handle,
      cleanup: cleanup(false, 1),
    });
    await expect(
      resources.settle(record.taskEpochDigest),
    ).resolves.toMatchObject({
      status: "settled",
      publicationOutcome: "committed",
    });
  });

  it("preserves recovered-new truth returned by cleanup retry", async () => {
    const record = await authenticReview();
    const handle = Object.freeze({ workflowId: "phase2-review" });
    const resources = createResources(
      causal({
        retryCleanup: async () => ({
          status: "cleaned",
          cleanup: cleanup(true, 2),
          publication: null,
          recovery: {
            ok: true,
            status: "recovered-new",
            publicationCommitted: true,
            journalPresent: false,
            recoveryRequired: false,
            transactionId: "transaction-a",
            requestDigest: "request-a",
            targetSetDigest: "targets-a",
            baselineDigest: "baseline-a",
            publishedTargets: 1,
            journalState: "committed",
          },
        }),
      }),
    );
    trackReview(resources, record);
    recordReviewOutcome(resources, record, {
      status: "cleanup-pending",
      code: "CLEANUP_FAILED",
      handle,
      cleanup: cleanup(false, 1),
    });
    await expect(
      resources.settle(record.taskEpochDigest),
    ).resolves.toMatchObject({
      status: "settled",
      publicationOutcome: "recovered-new",
    });
  });

  it("does not let a concurrent busy rejection erase the winning cleanup", async () => {
    const record = await authenticReview();
    const winner = deferred<Awaited<ReturnType<CausalWorkflow["reject"]>>>();
    const handle = Object.freeze({ workflowId: "phase2-review" });
    let rejects = 0;
    let retries = 0;
    const resources = createResources(
      causal({
        reject: async () => {
          rejects += 1;
          if (rejects === 1) return await winner.promise;
          return { status: "rejected", code: "WORKFLOW_BUSY", cleanup: null };
        },
        retryCleanup: async () => {
          retries += 1;
          return {
            status: "cleaned",
            cleanup: cleanup(true, 2),
            publication: null,
            recovery: null,
          };
        },
      }),
    );
    trackReview(resources, record);
    const winningSettlement = resources.settle(record.taskEpochDigest);
    await Promise.resolve();
    await expect(resources.settle(record.taskEpochDigest)).resolves.toEqual({
      status: "pending",
      stage: "cleanup",
    });
    winner.resolve({
      status: "cleanup-pending",
      code: "CLEANUP_FAILED",
      handle,
      cleanup: cleanup(false, 1),
    });
    await expect(winningSettlement).resolves.toEqual({
      status: "pending",
      stage: "cleanup",
    });
    await expect(
      resources.settle(record.taskEpochDigest),
    ).resolves.toMatchObject({ status: "settled" });
    expect(rejects).toBe(2);
    expect(retries).toBe(1);
  });

  it("retains the first recovery while converging two owned reviews", async () => {
    const first = authenticReview("workflow-first");
    const second = authenticReview("workflow-second");
    const recoveryHandle = Object.freeze({
      workflowId: "workflow-first",
      recoveryDigest: "recovery-first",
    });
    const cleanupHandle = Object.freeze({ workflowId: "workflow-second" });
    let rejects = 0;
    let recoveries = 0;
    let retries = 0;
    const resources = createResources(
      causal({
        rawReject: (input) => {
          rejects += 1;
          const workflowId = reviewWorkflowId(input);
          if (workflowId === "workflow-first") {
            return {
              status: "recovery-required",
              code: "PUBLICATION_UNCERTAIN",
              handle: recoveryHandle,
            };
          }
          return {
            status: "cleanup-pending",
            code: "CLEANUP_FAILED",
            handle: cleanupHandle,
            cleanup: cleanup(false, 1),
          };
        },
        recover: async () => {
          recoveries += 1;
          return {
            status: "recovered-without-publication",
            recovery: { ok: true, status: "recovered-old" },
            cleanup: cleanup(true, 2),
          };
        },
        retryCleanup: async () => {
          retries += 1;
          return {
            status: "cleaned",
            cleanup: cleanup(true, 2),
            publication: null,
            recovery: null,
          };
        },
      }),
    );
    trackReview(resources, first);
    trackReview(resources, second);
    await expect(resources.settle(first.taskEpochDigest)).resolves.toEqual({
      status: "pending",
      stage: "recovery",
    });
    expect(rejects).toBe(1);
    await expect(resources.settle(first.taskEpochDigest)).resolves.toEqual({
      status: "pending",
      stage: "cleanup",
    });
    expect(rejects).toBe(2);
    expect(recoveries).toBe(1);
    await expect(
      resources.settle(first.taskEpochDigest),
    ).resolves.toMatchObject({
      status: "settled",
      publicationOutcome: "recovered-old",
    });
    expect(retries).toBe(1);
  });
});

function authenticReview(workflowId = "phase2-review") {
  return Object.freeze({
    phase2: Object.freeze({ workflowId }),
    taskEpochDigest: digestValue("task-epoch"),
    review: Object.freeze({ workflowId: "engineering-review" }),
  });
}

function trackReview(
  resources: TaskEpochResources,
  record: ReturnType<typeof authenticReview>,
): void {
  Reflect.apply(TaskEpochResources.prototype.trackReview, resources, [record]);
}

function recordReviewOutcome(
  resources: TaskEpochResources,
  record: ReturnType<typeof authenticReview>,
  result: unknown,
): void {
  Reflect.apply(TaskEpochResources.prototype.recordReviewOutcome, resources, [
    record,
    result,
  ]);
}

function createResources(causalWorkflow: CausalWorkflow): TaskEpochResources {
  return new TaskEpochResources({
    continuations: new ContinuationLedger<PreparationState>(),
    causal: causalWorkflow,
    releaseBaseline: () => undefined,
    deleteContext: () => undefined,
  });
}

function causal(
  overrides: Readonly<{
    reject?: CausalWorkflow["reject"];
    recover?: CausalWorkflow["recover"];
    retryCleanup?: CausalWorkflow["retryCleanup"];
    rawReject?: (input: unknown) => unknown;
  }>,
): CausalWorkflow {
  const reject: (input: unknown) => Promise<WorkflowRejectionResult> =
    overrides.reject ??
    (async () => ({
      status: "rejected" as const,
      code: "WORKFLOW_STALE" as const,
      cleanup: null,
    }));
  const created: CausalWorkflow = Object.freeze({
    prepare: async () => await never(),
    approveAndPromote: async () => await never(),
    reject,
    recover:
      overrides.recover ??
      (async () => ({
        status: "rejected" as const,
        code: "WORKFLOW_STALE" as const,
      })),
    retryCleanup:
      overrides.retryCleanup ??
      (async () => ({
        status: "rejected" as const,
        code: "WORKFLOW_STALE" as const,
      })),
  });
  const rawReject = overrides.rawReject;
  if (rawReject === undefined) return created;
  return new Proxy<CausalWorkflow>(
    { ...created },
    {
      get(target, property, receiver) {
        if (property === "reject") {
          return async (input: unknown) =>
            await Reflect.apply(rawReject, undefined, [input]);
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
}

function reviewWorkflowId(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return;
  const review = Reflect.get(input, "review");
  return typeof review === "object" && review !== null
    ? Reflect.get(review, "workflowId")
    : undefined;
}

function cleanup(complete: boolean, attempt: number): WorkflowCleanupReceipt {
  return Object.freeze({
    workflowId: "workflow-a",
    attempt,
    approvalCancelled: true,
    taskWorktree: null,
    taskWorktreeCleanup: complete ? "session-closed" : "pending",
    targetReleased: complete,
    complete,
    receiptDigest: `cleanup-${attempt}`,
  });
}

async function never(): Promise<never> {
  throw new Error("unexpected causal operation");
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}
