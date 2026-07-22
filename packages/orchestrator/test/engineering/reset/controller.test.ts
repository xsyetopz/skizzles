// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import type { TaskCheckpointRestoration } from "../../../src/checkpoint.ts";
import { type Digest, digestValue } from "../../../src/digest.ts";
import type { TaskRuntimeInterruptRequest } from "../../../src/engineering/reset/contract.ts";
import {
  type ResetSettlement,
  TaskContextController,
} from "../../../src/engineering/reset/controller.ts";
import { createHarness, repositoryContext } from "../../support.ts";

describe("task context reset controller", () => {
  it("does not reuse an epoch across authentic repository context drift", async () => {
    let captures = 0;
    const harness = createHarness({
      repositoryCapture: (input) => {
        captures += 1;
        return {
          repositoryId: input.repositoryId,
          requestDigest: input.requestDigest,
          treeBytes: Array.from(new TextEncoder().encode("same-tree")),
          anchors: [
            {
              id: "runtime",
              precedence: "language-runtime",
              contentBytes: Array.from(
                new TextEncoder().encode(`context-${captures}`),
              ),
            },
          ],
        };
      },
    });
    const first = await repositoryContext(harness.orchestrator);
    const second = await repositoryContext(harness.orchestrator);
    const controller = new TaskContextController({
      taskId: "task-a",
      rootIdentity: "root-a",
      discoveryRoot: "packages/orchestrator",
      runtime: runtime(),
      settle: async () => ({
        status: "settled",
        workflowCleanupDigest: digestValue("cleanup"),
        publicationOutcome: "none",
      }),
      invalidate: (epoch) => digestValue(epoch),
      restore: async () => ({
        status: "rejected",
        code: "CHECKPOINT_NOT_FOUND",
      }),
      discover: (input) => harness.orchestrator.discoverTask(input),
    });
    expect(first.repository.treeDigest).toBe(second.repository.treeDigest);
    expect(first.repository.contextDigest).not.toBe(
      second.repository.contextDigest,
    );
    expect(
      controller.contextFor(first.request, first.repository),
    ).toBeDefined();
    expect(
      controller.contextFor(second.request, second.repository),
    ).toBeUndefined();
  });

  it("resumes recovery and cleanup with one-shot handles before fresh discovery", async () => {
    const harness = createHarness();
    const bindings = await repositoryContext(harness.orchestrator);
    await createCheckpoint(harness.orchestrator, bindings);
    const settlements: ResetSettlement[] = [
      { status: "pending", stage: "recovery" },
      { status: "pending", stage: "cleanup" },
      {
        status: "settled",
        workflowCleanupDigest: digestValue("cleanup"),
        publicationOutcome: "recovered-old",
      },
    ];
    let invalidations = 0;
    const controller = new TaskContextController({
      taskId: "task-a",
      rootIdentity: "root-a",
      discoveryRoot: "packages/orchestrator",
      runtime: runtime(),
      settle: async () =>
        settlements.shift() ?? {
          status: "settled",
          workflowCleanupDigest: digestValue("cleanup"),
          publicationOutcome: "recovered-old",
        },
      invalidate(taskEpochDigest) {
        invalidations += 1;
        return digestValue({ taskEpochDigest, invalidations });
      },
      restore: (input) => harness.orchestrator.restoreTaskCheckpoint(input),
      discover: (input) => harness.orchestrator.discoverTask(input),
    });
    const context = controller.contextFor(
      bindings.request,
      bindings.repository,
    );
    if (context === undefined) throw new Error("context setup failed");
    const recovery = await controller.resetContext({
      context,
      checkpointId: "checkpoint-a",
      reason: "context-renewal",
    });
    expect(recovery).toMatchObject({
      status: "reset-pending",
      stage: "recovery",
      code: "PUBLICATION_UNCERTAIN",
    });
    if (recovery.status !== "reset-pending") return;
    const cleanup = await controller.resumeContextReset({
      handle: recovery.handle,
    });
    expect(cleanup).toMatchObject({
      status: "reset-pending",
      stage: "cleanup",
      code: "CLEANUP_FAILED",
    });
    await expect(
      controller.resumeContextReset({ handle: recovery.handle }),
    ).resolves.toEqual({
      status: "rejected",
      code: "TASK_CONTEXT_STALE",
    });
    if (cleanup.status !== "reset-pending") return;
    const ready = await controller.resumeContextReset({
      handle: cleanup.handle,
    });
    expect(ready).toMatchObject({
      status: "ready",
      bootstrap: { inheritHistory: false },
      receipt: { publicationOutcome: "recovered-old" },
    });
    if (ready.status === "ready") {
      expect(ready.context.taskEpochDigest).not.toBe(context.taskEpochDigest);
      expect(ready.bootstrap.discovery.taskEpochDigest).toBe(
        ready.context.taskEpochDigest,
      );
    }
    expect(invalidations).toBe(1);
  });

  it("bounds an unresponsive interrupt and never settles or invalidates", async () => {
    const harness = createHarness();
    const bindings = await repositoryContext(harness.orchestrator);
    let settlements = 0;
    let invalidations = 0;
    const controller = new TaskContextController({
      taskId: "task-a",
      rootIdentity: "root-a",
      discoveryRoot: "packages/orchestrator",
      runtime: {
        timeoutMilliseconds: 5,
        interrupt: async () => await new Promise<never>(() => undefined),
      },
      settle: async () => {
        settlements += 1;
        return {
          status: "settled",
          workflowCleanupDigest: digestValue("unused"),
          publicationOutcome: "none",
        };
      },
      invalidate() {
        invalidations += 1;
        return digestValue("unused");
      },
      restore: async () => ({
        status: "rejected",
        code: "CHECKPOINT_NOT_FOUND",
      }),
      discover: (input) => harness.orchestrator.discoverTask(input),
    });
    const context = controller.contextFor(
      bindings.request,
      bindings.repository,
    );
    if (context === undefined) throw new Error("context setup failed");
    const pending = await controller.resetContext({
      context,
      checkpointId: "checkpoint-a",
      reason: "context-renewal",
    });
    expect(pending).toMatchObject({
      status: "reset-pending",
      stage: "interrupt",
      code: "INTERRUPT_UNCONFIRMED",
    });
    expect(settlements).toBe(0);
    expect(invalidations).toBe(0);
  });

  it("reports checkpoint drift after interruption without exposing a new epoch", async () => {
    const harness = createHarness();
    const bindings = await repositoryContext(harness.orchestrator);
    const controller = new TaskContextController({
      taskId: "task-a",
      rootIdentity: "root-a",
      discoveryRoot: "packages/orchestrator",
      runtime: runtime(),
      settle: async () => ({
        status: "settled",
        workflowCleanupDigest: digestValue("cleanup"),
        publicationOutcome: "not-published",
      }),
      invalidate: (epoch) => digestValue({ epoch, invalidated: true }),
      restore: async () => ({ status: "rejected", code: "TREE_DRIFT" }),
      discover: (input) => harness.orchestrator.discoverTask(input),
    });
    const context = controller.contextFor(
      bindings.request,
      bindings.repository,
    );
    if (context === undefined) throw new Error("context setup failed");
    const pending = await controller.resetContext({
      context,
      checkpointId: "checkpoint-a",
      reason: "context-renewal",
    });
    expect(pending).toMatchObject({
      status: "reset-pending",
      stage: "checkpoint",
      code: "CHECKPOINT_DRIFTED",
    });
    expect(
      controller.contextFor(bindings.request, bindings.repository),
    ).toBeUndefined();
  });

  it("rejects a recomputed but unbranded restoration receipt", async () => {
    const harness = createHarness();
    const bindings = await repositoryContext(harness.orchestrator);
    const controller = new TaskContextController({
      taskId: "task-a",
      rootIdentity: "root-a",
      discoveryRoot: "packages/orchestrator",
      runtime: runtime(),
      settle: async () => ({
        status: "settled",
        workflowCleanupDigest: digestValue("cleanup"),
        publicationOutcome: "not-published",
      }),
      invalidate: (epoch) => digestValue(epoch),
      restore: async (input) => forgedRestoration(input),
      discover: (input) => harness.orchestrator.discoverTask(input),
    });
    const context = controller.contextFor(
      bindings.request,
      bindings.repository,
    );
    if (context === undefined) throw new Error("context setup failed");
    await expect(
      controller.resetContext({
        context,
        checkpointId: "checkpoint-a",
        reason: "context-renewal",
      }),
    ).resolves.toMatchObject({
      status: "reset-pending",
      stage: "checkpoint",
      code: "CHECKPOINT_DRIFTED",
    });
  });

  it("keeps the new epoch private after an authentic stale-epoch discovery", async () => {
    const harness = createHarness();
    const bindings = await repositoryContext(harness.orchestrator);
    await createCheckpoint(harness.orchestrator, bindings);
    let discoveries = 0;
    let invalidations = 0;
    let previousEpoch: TaskRuntimeInterruptRequest["taskEpochDigest"] | null =
      null;
    const controller = new TaskContextController({
      taskId: "task-a",
      rootIdentity: "root-a",
      discoveryRoot: "packages/orchestrator",
      runtime: runtime(),
      settle: async () => ({
        status: "settled",
        workflowCleanupDigest: digestValue("cleanup"),
        publicationOutcome: "not-published",
      }),
      invalidate: (epoch) => {
        invalidations += 1;
        return digestValue({ epoch, invalidations });
      },
      restore: (input) => harness.orchestrator.restoreTaskCheckpoint(input),
      discover: async (input) => {
        discoveries += 1;
        if (discoveries === 1 && previousEpoch !== null) {
          return await harness.orchestrator.discoverTask({
            request: bindings.request,
            repository: bindings.repository,
            root: "packages/orchestrator",
            taskId: "task-a",
            taskEpochDigest: previousEpoch,
          });
        }
        return await harness.orchestrator.discoverTask(input);
      },
    });
    const context = controller.contextFor(
      bindings.request,
      bindings.repository,
    );
    if (context === undefined) throw new Error("context setup failed");
    previousEpoch = context.taskEpochDigest;
    const pending = await controller.resetContext({
      context,
      checkpointId: "checkpoint-a",
      reason: "context-renewal",
    });
    expect(pending).toMatchObject({
      status: "reset-pending",
      stage: "discovery",
      code: "DISCOVERY_INCOMPLETE",
    });
    expect(
      controller.contextFor(bindings.request, bindings.repository),
    ).toBeUndefined();
    if (pending.status !== "reset-pending") return;
    const ready = await controller.resumeContextReset({
      handle: pending.handle,
    });
    expect(ready).toMatchObject({
      status: "ready",
      bootstrap: { inheritHistory: false },
    });
    expect(discoveries).toBe(2);
    expect(invalidations).toBe(1);
  });
});

function runtime() {
  return Object.freeze({
    timeoutMilliseconds: 25,
    interrupt(input: TaskRuntimeInterruptRequest): unknown {
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
  });
}

async function forgedRestoration(
  input: unknown,
): Promise<TaskCheckpointRestoration> {
  if (typeof input !== "object" || input === null) {
    return { status: "rejected", code: "INVALID_CHECKPOINT_INPUT" };
  }
  const value = input as Readonly<Record<string, unknown>>;
  const request = value["request"] as Readonly<Record<string, unknown>>;
  const repository = value["repository"] as Readonly<Record<string, unknown>>;
  const requestDigest = request["intentDigest"];
  const repositoryTreeDigest = repository["treeDigest"];
  const contextDigest = repository["contextDigest"];
  if (
    !(
      isDigest(requestDigest) &&
      isDigest(repositoryTreeDigest) &&
      isDigest(contextDigest)
    )
  ) {
    return {
      status: "rejected",
      code: "INVALID_CHECKPOINT_INPUT",
    };
  }
  const checkpointEvidenceDigest = digestValue("forged");
  const material = {
    checkpointId: String(value["id"]),
    taskId: String(value["taskId"]),
    repositoryId: String(repository["repositoryId"]),
    rootIdentity: String(value["rootIdentity"]),
    requestDigest,
    repositoryTreeDigest,
    contextDigest,
    checkpointEvidenceDigest,
  };
  return {
    status: "restored" as const,
    receipt: Object.freeze({
      ...material,
      restorationDigest: digestValue(material),
    }),
  };
}

async function createCheckpoint(
  orchestrator: ReturnType<typeof createHarness>["orchestrator"],
  bindings: Awaited<ReturnType<typeof repositoryContext>>,
): Promise<void> {
  const created = await orchestrator.createTaskCheckpoint({
    id: "checkpoint-a",
    taskId: "task-a",
    rootIdentity: "root-a",
    request: bindings.request,
    repository: bindings.repository,
  });
  if (created.status !== "accepted") throw new Error("checkpoint rejected");
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
