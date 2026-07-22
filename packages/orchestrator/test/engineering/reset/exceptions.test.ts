// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { digestValue } from "../../../src/digest.ts";
import type { TaskRuntimeInterruptRequest } from "../../../src/engineering/reset/contract.ts";
import { TaskContextController } from "../../../src/engineering/reset/controller.ts";
import { createHarness, repositoryContext } from "../../support.ts";

type FaultStage = "discover" | "invalidate" | "restore" | "settle";

describe("reset authority exception recovery", () => {
  it("retries settlement exceptions through a one-shot recovery handle", async () => {
    const result = await exercise("settle");
    expect(result.pending).toMatchObject({
      status: "reset-pending",
      stage: "recovery",
      code: "PUBLICATION_UNCERTAIN",
    });
    expect(result.counts).toEqual({
      settle: 2,
      invalidate: 1,
      restore: 1,
      discover: 1,
    });
  });

  it("retries invalidation without repeating successful settlement", async () => {
    const result = await exercise("invalidate");
    expect(result.pending).toMatchObject({
      status: "reset-pending",
      stage: "cleanup",
      code: "CLEANUP_FAILED",
    });
    expect(result.counts).toEqual({
      settle: 1,
      invalidate: 2,
      restore: 1,
      discover: 1,
    });
  });

  it("retries checkpoint authority exceptions with the exact scope", async () => {
    const result = await exercise("restore");
    expect(result.pending).toMatchObject({
      status: "reset-pending",
      stage: "checkpoint",
      code: "CHECKPOINT_UNAVAILABLE",
    });
    expect(result.counts).toEqual({
      settle: 1,
      invalidate: 1,
      restore: 2,
      discover: 1,
    });
  });

  it("retries discovery exceptions without exposing the new epoch", async () => {
    const result = await exercise("discover");
    expect(result.pending).toMatchObject({
      status: "reset-pending",
      stage: "discovery",
      code: "DISCOVERY_INCOMPLETE",
    });
    expect(result.counts).toEqual({
      settle: 1,
      invalidate: 1,
      restore: 1,
      discover: 2,
    });
  });
});

async function exercise(fault: FaultStage) {
  const harness = createHarness();
  const bindings = await repositoryContext(harness.orchestrator);
  const created = await harness.orchestrator.createTaskCheckpoint({
    id: `checkpoint-${fault}`,
    taskId: "task-a",
    rootIdentity: "root-a",
    request: bindings.request,
    repository: bindings.repository,
  });
  if (created.status !== "accepted") throw new Error("checkpoint rejected");
  const counts = { settle: 0, invalidate: 0, restore: 0, discover: 0 };
  const controller = new TaskContextController({
    taskId: "task-a",
    rootIdentity: "root-a",
    discoveryRoot: "packages/orchestrator",
    runtime: runtime(),
    settle: async () => {
      counts.settle += 1;
      throwFirst(fault, "settle", counts.settle);
      return {
        status: "settled",
        workflowCleanupDigest: digestValue("cleanup"),
        publicationOutcome: "not-published",
      };
    },
    invalidate: (epoch) => {
      counts.invalidate += 1;
      throwFirst(fault, "invalidate", counts.invalidate);
      return digestValue({ epoch, invalidated: true });
    },
    restore: async (input) => {
      counts.restore += 1;
      throwFirst(fault, "restore", counts.restore);
      return await harness.orchestrator.restoreTaskCheckpoint(input);
    },
    discover: async (input) => {
      counts.discover += 1;
      throwFirst(fault, "discover", counts.discover);
      return await harness.orchestrator.discoverTask(input);
    },
  });
  const context = controller.contextFor(bindings.request, bindings.repository);
  if (context === undefined) throw new Error("context rejected");
  const pending = await controller.resetContext({
    context,
    checkpointId: `checkpoint-${fault}`,
    reason: "context-renewal",
  });
  if (pending.status !== "reset-pending") {
    throw new Error("fault did not produce a pending reset");
  }
  if (
    controller.contextFor(bindings.request, bindings.repository) !== undefined
  ) {
    throw new Error("new context was exposed before retry");
  }
  const ready = await controller.resumeContextReset({ handle: pending.handle });
  if (ready.status !== "ready") throw new Error("reset retry did not complete");
  const replay = await controller.resumeContextReset({
    handle: pending.handle,
  });
  if (replay.status !== "rejected" || replay.code !== "TASK_CONTEXT_STALE") {
    throw new Error("reset handle replay was accepted");
  }
  return { pending, counts };
}

function throwFirst(
  fault: FaultStage,
  stage: FaultStage,
  attempt: number,
): void {
  if (fault === stage && attempt === 1) throw new Error(`${stage} unavailable`);
}

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
