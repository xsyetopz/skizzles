import { describe, expect, it } from "bun:test";
import { createHarness, repositoryContext } from "../facade/support.ts";

describe("host-owned execution budgets", () => {
  it("admits each exact high-risk boundary and exhausts one event over", async () => {
    for (const fixture of [
      { kind: "action", allowed: 2 },
      { kind: "retry", allowed: 1 },
      { kind: "causal-failure", allowed: 1 },
    ] as const) {
      const { orchestrator } = createHarness();
      const context = await repositoryContext(orchestrator);
      const started = orchestrator.startExecution(context);
      if (started.status !== "accepted") throw new Error("start rejected");
      let execution = started.execution;
      for (let index = 0; index < fixture.allowed; index += 1) {
        const result = orchestrator.recordExecution({
          execution,
          kind: fixture.kind,
          ...(fixture.kind === "causal-failure"
            ? { causalFailureId: "same-root-cause" }
            : {}),
        });
        if (result.status !== "accepted") {
          throw new Error("exact bound rejected");
        }
        execution = result.execution;
      }
      expect(
        orchestrator.recordExecution({
          execution,
          kind: fixture.kind,
          ...(fixture.kind === "causal-failure"
            ? { causalFailureId: "same-root-cause" }
            : {}),
        }),
      ).toEqual({ status: "rejected", code: "EXECUTION_EXHAUSTED" });
      expect(
        orchestrator.recordExecution({ execution, kind: "action" }),
      ).toEqual({ status: "rejected", code: "EXECUTION_EXHAUSTED" });
      expect(orchestrator.startExecution(context)).toEqual({
        status: "rejected",
        code: "EXECUTION_ALREADY_EXISTS",
      });
    }
  });

  it("uses the host clock and permits the exact deadline only", async () => {
    const exact = createHarness();
    const context = await repositoryContext(exact.orchestrator);
    const started = exact.orchestrator.startExecution(context);
    if (started.status !== "accepted") throw new Error("start rejected");
    exact.clock.advance(500);
    expect(
      exact.orchestrator.recordExecution({
        execution: started.execution,
        kind: "action",
      }).status,
    ).toBe("accepted");

    const over = createHarness();
    const overContext = await repositoryContext(over.orchestrator);
    const overStarted = over.orchestrator.startExecution(overContext);
    if (overStarted.status !== "accepted") throw new Error("start rejected");
    over.clock.advance(501);
    expect(
      over.orchestrator.recordExecution({
        execution: overStarted.execution,
        kind: "action",
      }),
    ).toEqual({ status: "rejected", code: "EXECUTION_EXHAUSTED" });
  });

  it("requires the configured full completion contract and seals on success", async () => {
    const incomplete = createHarness({
      completionVerify(input) {
        return {
          executionId: input.executionId,
          requestDigest: input.request.intentDigest,
          repositoryId: input.repository.repositoryId,
          treeDigest: input.repository.treeDigest,
          contractId: input.contractId,
          checks: [{ id: "lint", passed: true, evidenceBytes: [1] }],
        };
      },
    });
    const incompleteContext = await repositoryContext(incomplete.orchestrator);
    const incompleteStart =
      incomplete.orchestrator.startExecution(incompleteContext);
    if (incompleteStart.status !== "accepted") {
      throw new Error("start rejected");
    }
    await expect(
      incomplete.orchestrator.completeExecution({
        execution: incompleteStart.execution,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "COMPLETION_CONTRACT_REJECTED",
    });

    const complete = createHarness();
    const completeContext = await repositoryContext(complete.orchestrator);
    const completeStart = complete.orchestrator.startExecution(completeContext);
    if (completeStart.status !== "accepted") throw new Error("start rejected");
    const result = await complete.orchestrator.completeExecution({
      execution: completeStart.execution,
    });
    expect(result.status).toBe("completed");
    expect(complete.counts.completion).toBe(1);
    await expect(
      complete.orchestrator.completeExecution({
        execution: completeStart.execution,
      }),
    ).resolves.toEqual({ status: "rejected", code: "EXECUTION_SEALED" });
    expect(
      complete.orchestrator.recordExecution({
        execution: completeStart.execution,
        kind: "action",
      }),
    ).toEqual({ status: "rejected", code: "EXECUTION_SEALED" });
    expect(complete.counts.completion).toBe(1);
  });

  it("rejects caller-shaped sessions and malformed events without authority calls", async () => {
    const { orchestrator, counts } = createHarness();
    const context = await repositoryContext(orchestrator);
    const started = orchestrator.startExecution(context);
    if (started.status !== "accepted") throw new Error("start rejected");
    expect(
      orchestrator.recordExecution({
        execution: { ...started.execution },
        kind: "action",
      }),
    ).toEqual({ status: "rejected", code: "INVALID_EXECUTION_EVENT" });
    expect(
      orchestrator.recordExecution({
        execution: started.execution,
        kind: "causal-failure",
      }),
    ).toEqual({ status: "rejected", code: "INVALID_EXECUTION_EVENT" });
    expect(counts.completion).toBe(0);
  });

  it("terminates failed attempts, releases dedupe, and preserves consumed budget", async () => {
    const { orchestrator } = createHarness();
    const context = await repositoryContext(orchestrator);
    const started = orchestrator.startExecution(context);
    if (started.status !== "accepted") throw new Error("start rejected");
    const action = orchestrator.recordExecution({
      execution: started.execution,
      kind: "action",
    });
    if (action.status !== "accepted") throw new Error("action rejected");

    expect(
      orchestrator.terminateExecution({
        execution: action.execution,
        kind: "failed",
      }),
    ).toEqual({ status: "terminated", kind: "failed" });

    const retry = orchestrator.startExecution(context);
    if (retry.status !== "accepted") throw new Error("retry rejected");
    expect(retry.execution.executionId).not.toBe(action.execution.executionId);
    expect(retry.execution.actions).toBe(1);
    expect(retry.execution.retries).toBe(1);
    expect(retry.execution.startedAtMs).toBe(started.execution.startedAtMs);
    expect(retry.execution.deadlineMs).toBe(started.execution.deadlineMs);

    expect(
      orchestrator.terminateExecution({
        execution: retry.execution,
        kind: "failed",
      }),
    ).toEqual({ status: "terminated", kind: "failed" });
    expect(orchestrator.startExecution(context)).toEqual({
      status: "rejected",
      code: "EXECUTION_EXHAUSTED",
    });
  });

  it("fails closed for stale, double, malformed, and sealed terminal calls", async () => {
    const { orchestrator } = createHarness();
    const context = await repositoryContext(orchestrator);
    const first = orchestrator.startExecution(context);
    if (first.status !== "accepted") throw new Error("start rejected");
    expect(
      orchestrator.terminateExecution({
        execution: first.execution,
        kind: "cancelled",
      }),
    ).toEqual({ status: "terminated", kind: "cancelled" });
    expect(
      orchestrator.terminateExecution({
        execution: first.execution,
        kind: "cancelled",
      }),
    ).toEqual({ status: "rejected", code: "EXECUTION_STALE" });
    expect(
      orchestrator.terminateExecution({
        execution: first.execution,
        kind: "unknown",
      }),
    ).toEqual({
      status: "rejected",
      code: "INVALID_EXECUTION_TERMINATION",
    });

    const second = orchestrator.startExecution(context);
    if (second.status !== "accepted") throw new Error("retry rejected");
    expect(
      orchestrator.terminateExecution({
        execution: first.execution,
        kind: "failed",
      }),
    ).toEqual({ status: "rejected", code: "EXECUTION_STALE" });
    const completion = await orchestrator.completeExecution({
      execution: second.execution,
    });
    expect(completion.status).toBe("completed");
    expect(
      orchestrator.terminateExecution({
        execution: second.execution,
        kind: "failed",
      }),
    ).toEqual({ status: "rejected", code: "EXECUTION_SEALED" });
    expect(orchestrator.terminateExecution(null)).toEqual({
      status: "rejected",
      code: "INVALID_EXECUTION_TERMINATION",
    });
  });
});
