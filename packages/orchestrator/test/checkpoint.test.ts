// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import {
  createHarness,
  repositoryContext,
  verificationEvidence,
} from "./support.ts";

describe("authority-captured checkpoints", () => {
  it("captures command, output, compiler, test, verifier, and tree bytes", async () => {
    const { orchestrator } = createHarness({
      verification: [verificationEvidence("one"), verificationEvidence("one")],
    });
    const created = await orchestrator.createCheckpoint({ id: "phase-1" });
    expect(created.status).toBe("accepted");
    if (created.status === "accepted") {
      expect(
        created.checkpoint.evidence.compiler.commandBytes.length,
      ).toBeGreaterThan(0);
      expect(
        created.checkpoint.evidence.compiler.outputBytes.length,
      ).toBeGreaterThan(0);
      expect(
        Object.isFrozen(created.checkpoint.evidence.compiler.outputBytes),
      ).toBe(true);
    }
    expect(await orchestrator.validateCheckpoint({ id: "phase-1" })).toEqual({
      status: "valid",
    });
  });

  it("rejects caller-authored evidence and malformed calls without throwing", async () => {
    const { orchestrator } = createHarness();
    expect(
      await orchestrator.createCheckpoint({
        id: "forged",
        evidence: { treeDigest: `sha256:${"0".repeat(64)}` },
      }),
    ).toEqual({ status: "rejected", code: "INVALID_CHECKPOINT_INPUT" });
    await expect(orchestrator.createCheckpoint(null)).resolves.toEqual({
      status: "rejected",
      code: "INVALID_CHECKPOINT_INPUT",
    });
  });

  it("rejects repeated identical evidence across a supersession chain", async () => {
    const first = verificationEvidence("first");
    const second = verificationEvidence("second");
    const { orchestrator } = createHarness({
      verification: [first, second, first],
    });
    expect(
      (await orchestrator.createCheckpoint({ id: "phase-1" })).status,
    ).toBe("accepted");
    expect(
      (
        await orchestrator.supersedeCheckpoint({
          previousId: "phase-1",
          id: "phase-2",
          rationale: "Fresh evidence after the reviewed change.",
        })
      ).status,
    ).toBe("accepted");
    expect(
      await orchestrator.supersedeCheckpoint({
        previousId: "phase-2",
        id: "phase-3",
        rationale: "A third verification run was requested.",
      }),
    ).toEqual({
      status: "rejected",
      code: "SUPERSESSION_REQUIRES_NEW_EVIDENCE",
    });
  });

  it("requires rationale and rejects failed verification authority evidence", async () => {
    const failed = verificationEvidence("failed");
    const failedTests = { ...failed.tests, exitCode: 1 };
    const authorityResult = { ...failed, tests: failedTests };
    const { orchestrator } = createHarness({ verification: [authorityResult] });
    expect(await orchestrator.createCheckpoint({ id: "failed" })).toEqual({
      status: "rejected",
      code: "VERIFICATION_AUTHORITY_REJECTED",
    });

    const valid = createHarness({
      verification: [verificationEvidence("one")],
    }).orchestrator;
    await valid.createCheckpoint({ id: "one" });
    expect(
      await valid.supersedeCheckpoint({
        previousId: "one",
        id: "two",
        rationale: " ",
      }),
    ).toEqual({
      status: "rejected",
      code: "INVALID_SUPERSESSION_RATIONALE",
    });
  });

  it("serializes concurrent creates for the same checkpoint id", async () => {
    const capture = deferred<unknown>();
    const { orchestrator } = createHarness({
      verification: [capture.promise, verificationEvidence("other")],
    });
    const first = orchestrator.createCheckpoint({ id: "phase-race" });
    await Promise.resolve();
    expect(await orchestrator.createCheckpoint({ id: "phase-race" })).toEqual({
      status: "rejected",
      code: "CHECKPOINT_OPERATION_IN_PROGRESS",
    });
    capture.resolve(verificationEvidence("winner"));
    expect((await first).status).toBe("accepted");
  });

  it("serializes concurrent supersessions from one predecessor", async () => {
    const capture = deferred<unknown>();
    const { orchestrator } = createHarness({
      verification: [
        verificationEvidence("initial"),
        capture.promise,
        verificationEvidence("other"),
      ],
    });
    await orchestrator.createCheckpoint({ id: "phase-1" });
    const first = orchestrator.supersedeCheckpoint({
      previousId: "phase-1",
      id: "phase-2a",
      rationale: "First concurrent verified successor.",
    });
    await Promise.resolve();
    expect(
      await orchestrator.supersedeCheckpoint({
        previousId: "phase-1",
        id: "phase-2b",
        rationale: "Second concurrent verified successor.",
      }),
    ).toEqual({
      status: "rejected",
      code: "CHECKPOINT_OPERATION_IN_PROGRESS",
    });
    capture.resolve(verificationEvidence("successor"));
    expect((await first).status).toBe("accepted");
  });

  it("releases a failed authority reservation for a safe retry", async () => {
    const { orchestrator } = createHarness({
      verification: [
        Promise.reject(new Error("capture failed")),
        verificationEvidence("retry"),
      ],
    });
    expect(await orchestrator.createCheckpoint({ id: "retry" })).toEqual({
      status: "rejected",
      code: "VERIFICATION_AUTHORITY_REJECTED",
    });
    expect((await orchestrator.createCheckpoint({ id: "retry" })).status).toBe(
      "accepted",
    );
  });

  it("releases failed supersession reservations for a safe retry", async () => {
    const { orchestrator } = createHarness({
      verification: [
        verificationEvidence("initial"),
        Promise.reject(new Error("supersession capture failed")),
        verificationEvidence("retry-successor"),
      ],
    });
    await orchestrator.createCheckpoint({ id: "phase-1" });
    const input = {
      previousId: "phase-1",
      id: "phase-2",
      rationale: "Retry after an unavailable verification authority.",
    };
    expect(await orchestrator.supersedeCheckpoint(input)).toEqual({
      status: "rejected",
      code: "VERIFICATION_AUTHORITY_REJECTED",
    });
    expect((await orchestrator.supersedeCheckpoint(input)).status).toBe(
      "accepted",
    );
  });

  it("logically restores only an exact task-bound checkpoint", async () => {
    const { orchestrator } = createHarness({
      verification: [
        verificationEvidence("task"),
        verificationEvidence("task"),
      ],
    });
    const bindings = await repositoryContext(orchestrator);
    const scope = {
      id: "task-checkpoint",
      taskId: "task-a",
      rootIdentity: "root-a",
      request: bindings.request,
      repository: bindings.repository,
    };
    expect((await orchestrator.createTaskCheckpoint(scope)).status).toBe(
      "accepted",
    );
    await expect(
      orchestrator.restoreTaskCheckpoint(scope),
    ).resolves.toMatchObject({
      status: "restored",
      receipt: { checkpointId: "task-checkpoint", taskId: "task-a" },
    });
    await expect(
      orchestrator.restoreTaskCheckpoint({ ...scope, taskId: "task-b" }),
    ).resolves.toEqual({
      status: "rejected",
      code: "CHECKPOINT_SCOPE_MISMATCH",
    });
  });

  it("rejects restoration when its checkpoint is superseded during capture", async () => {
    const restoration = deferred<unknown>();
    const { orchestrator } = createHarness({
      verification: [
        verificationEvidence("initial"),
        restoration.promise,
        verificationEvidence("successor"),
      ],
    });
    const bindings = await repositoryContext(orchestrator);
    const scope = {
      id: "task-checkpoint",
      taskId: "task-a",
      rootIdentity: "root-a",
      request: bindings.request,
      repository: bindings.repository,
    };
    expect((await orchestrator.createTaskCheckpoint(scope)).status).toBe(
      "accepted",
    );
    const restoring = orchestrator.restoreTaskCheckpoint(scope);
    await Promise.resolve();
    const superseding = orchestrator.supersedeCheckpoint({
      previousId: scope.id,
      id: "task-checkpoint-next",
      rationale: "Fresh successor while restoration evidence is in flight.",
    });
    expect((await superseding).status).toBe("accepted");
    restoration.resolve(verificationEvidence("initial"));
    await expect(restoring).resolves.toEqual({
      status: "rejected",
      code: "CHECKPOINT_SUPERSEDED",
    });
  });

  it("binds task checkpoints to the authentic repository context digest", async () => {
    let captures = 0;
    const { orchestrator } = createHarness({
      verification: [verificationEvidence("context")],
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
                new TextEncoder().encode(`runtime-context-${captures}`),
              ),
            },
          ],
        };
      },
    });
    const first = await repositoryContext(orchestrator);
    const second = await repositoryContext(orchestrator);
    expect(first.repository.treeDigest).toBe(second.repository.treeDigest);
    expect(first.repository.contextDigest).not.toBe(
      second.repository.contextDigest,
    );
    const scope = {
      id: "context-checkpoint",
      taskId: "task-a",
      rootIdentity: "root-a",
      request: first.request,
      repository: first.repository,
    };
    expect((await orchestrator.createTaskCheckpoint(scope)).status).toBe(
      "accepted",
    );
    await expect(
      orchestrator.restoreTaskCheckpoint({
        ...scope,
        request: second.request,
        repository: second.repository,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "CHECKPOINT_SCOPE_MISMATCH",
    });
  });
});

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
    resolve(value: Value) {
      resolvePromise?.(value);
    },
  };
}
