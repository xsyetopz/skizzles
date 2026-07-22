// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import type {
  ApprovalRequest,
  DiscoverySnapshot,
  NormalizedRequest,
  Orchestrator,
  RepositoryContext,
  TargetBaseline,
} from "../../src/index.ts";
import { createHarness, repositoryContext } from "../support.ts";

const transactionDigest = `sha256:${"a".repeat(64)}` as const;

interface ApprovalFixture {
  readonly request: NormalizedRequest;
  readonly repository: RepositoryContext;
  readonly baseline: TargetBaseline;
  readonly discovery: DiscoverySnapshot;
}

async function fixture(orchestrator: Orchestrator): Promise<ApprovalFixture> {
  const context = await repositoryContext(orchestrator);
  const baseline = await orchestrator.captureTargetBaseline({
    ...context,
    targets: ["packages/orchestrator/src/runtime.ts"],
  });
  if (baseline.status !== "accepted") throw new Error("baseline rejected");
  const discovery = await orchestrator.discover({
    ...context,
    root: "packages/orchestrator",
  });
  if (discovery.status !== "accepted") throw new Error("discovery rejected");
  return {
    ...context,
    baseline: baseline.baseline,
    discovery: discovery.discovery,
  };
}

function plan(
  orchestrator: Orchestrator,
  input: ApprovalFixture,
): ApprovalRequest {
  const result = orchestrator.planApproval({
    taskId: "task-1",
    principalId: "maintainer-1",
    operation: "publish-transaction",
    ...input,
    transactionDigest,
    diffBytes: Array.from(new TextEncoder().encode("diff --git a/x b/x\n")),
  });
  if (result.status !== "accepted") throw new Error("plan rejected");
  return result.approval;
}

function transition(
  orchestrator: Orchestrator,
  approval: ApprovalRequest,
  method: "review" | "await",
): ApprovalRequest {
  const result =
    method === "review"
      ? orchestrator.reviewApproval({ approval })
      : orchestrator.awaitApproval({ approval });
  if (result.status !== "accepted") throw new Error("transition rejected");
  return result.approval;
}

describe("single-use external approval gate", () => {
  it("binds the immutable full diff and every authority identity through promotion", async () => {
    const { orchestrator, counts } = createHarness();
    const input = await fixture(orchestrator);
    const planned = plan(orchestrator, input);
    expect(planned.state).toBe("planned");
    expect(Object.isFrozen(planned.diffBytes)).toBe(true);
    const reviewed = transition(orchestrator, planned, "review");
    const awaiting = transition(orchestrator, reviewed, "await");
    expect(awaiting.state).toBe("awaiting");
    expect(awaiting.challenge).toMatchObject({
      taskId: "task-1",
      principalId: "maintainer-1",
      operation: "publish-transaction",
      requestDigest: input.request.intentDigest,
      treeDigest: input.repository.treeDigest,
      baselineDigest: input.baseline.baselineDigest,
      transactionDigest,
      discoveryDigest: input.discovery.discoveryDigest,
      diffDigest: planned.diffDigest,
    });
    const approved = await orchestrator.approve({
      approval: awaiting,
      token: "approve",
    });
    if (approved.status !== "accepted") throw new Error("approval rejected");
    expect(approved.approval.state).toBe("approved");
    const promoted = await orchestrator.promote({
      approval: approved.approval,
    });
    expect(promoted).toMatchObject({
      status: "promoting",
      permit: {
        taskId: "task-1",
        principalId: "maintainer-1",
        transactionDigest,
        diffDigest: planned.diffDigest,
      },
    });
    expect(counts.authenticate).toBe(1);
    expect(counts.targetRevalidate).toBe(1);
    await expect(
      orchestrator.promote({ approval: approved.approval }),
    ).resolves.toEqual({ status: "rejected", code: "APPROVAL_STALE" });
  });

  it("rejects incomplete discovery before any approval state exists", async () => {
    const { orchestrator } = createHarness({
      discoveryScan(input) {
        return {
          repositoryId: input.repositoryId,
          requestDigest: input.requestDigest,
          treeDigest: input.treeDigest,
          root: input.root,
          entries: [],
          skippedSymlinks: [],
          complete: false,
          stoppedBy: "files",
        };
      },
    });
    const input = await fixture(orchestrator);
    expect(
      orchestrator.planApproval({
        taskId: "task-1",
        principalId: "maintainer-1",
        operation: "publish-transaction",
        ...input,
        transactionDigest,
        diffBytes: [1],
      }),
    ).toEqual({ status: "rejected", code: "DISCOVERY_INCOMPLETE" });
  });

  it("is concurrent, replay, cancellation, and expiry safe", async () => {
    let resolveAuth: ((value: unknown) => void) | undefined;
    const auth = new Promise<unknown>((resolve) => {
      resolveAuth = resolve;
    });
    let challenge: ApprovalRequest["challenge"] | undefined;
    const concurrent = createHarness({
      authenticate(input) {
        challenge = input.challenge;
        return auth;
      },
    });
    const input = await fixture(concurrent.orchestrator);
    const awaiting = transition(
      concurrent.orchestrator,
      transition(
        concurrent.orchestrator,
        plan(concurrent.orchestrator, input),
        "review",
      ),
      "await",
    );
    const first = concurrent.orchestrator.approve({
      approval: awaiting,
      token: "approve",
    });
    await Promise.resolve();
    await expect(
      concurrent.orchestrator.approve({ approval: awaiting, token: "approve" }),
    ).resolves.toEqual({ status: "rejected", code: "APPROVAL_BUSY" });
    expect(
      concurrent.orchestrator.cancelApproval({ approval: awaiting }),
    ).toEqual({
      status: "cancelled",
    });
    if (resolveAuth === undefined || challenge == null)
      throw new Error("authentication did not begin");
    resolveAuth({
      challengeDigest: challenge.challengeDigest,
      taskId: challenge.taskId,
      principalId: challenge.principalId,
      operation: challenge.operation,
      authorized: true,
      verifiedAtMs: concurrent.clock.now(),
    });
    await expect(first).resolves.toEqual({
      status: "rejected",
      code: "APPROVAL_CANCELLED",
    });

    const expired = createHarness();
    const expiredInput = await fixture(expired.orchestrator);
    const expiredAwaiting = transition(
      expired.orchestrator,
      transition(
        expired.orchestrator,
        plan(expired.orchestrator, expiredInput),
        "review",
      ),
      "await",
    );
    expired.clock.advance(201);
    await expect(
      expired.orchestrator.approve({
        approval: expiredAwaiting,
        token: "approve",
      }),
    ).resolves.toEqual({ status: "rejected", code: "APPROVAL_EXPIRED" });
    expect(expired.counts.authenticate).toBe(0);
  });

  it("cancels promotion when the target authority detects drift", async () => {
    const { orchestrator, counts } = createHarness({
      targetRevalidate(input) {
        return {
          reservationId: input.reservationId,
          repositoryId: input.repositoryId,
          requestDigest: input.requestDigest,
          treeDigest: input.treeDigest,
          targets: input.targets,
          headDigest: `sha256:${"0".repeat(64)}`,
          indexDigest: input.indexDigest,
          worktreeDigest: input.worktreeDigest,
          statusDigest: input.statusDigest,
          unchanged: true,
        };
      },
    });
    const input = await fixture(orchestrator);
    const awaiting = transition(
      orchestrator,
      transition(orchestrator, plan(orchestrator, input), "review"),
      "await",
    );
    const approved = await orchestrator.approve({
      approval: awaiting,
      token: "approve",
    });
    if (approved.status !== "accepted") throw new Error("approval rejected");
    await expect(
      orchestrator.promote({ approval: approved.approval }),
    ).resolves.toEqual({ status: "rejected", code: "APPROVAL_DRIFTED" });
    expect(counts.targetRevalidate).toBe(1);
    await expect(
      orchestrator.promote({ approval: approved.approval }),
    ).resolves.toEqual({ status: "rejected", code: "APPROVAL_CANCELLED" });
  });

  it("does not permit state mutation while awaiting authorization", async () => {
    const { orchestrator } = createHarness();
    const input = await fixture(orchestrator);
    const awaiting = transition(
      orchestrator,
      transition(orchestrator, plan(orchestrator, input), "review"),
      "await",
    );
    expect(orchestrator.reviewApproval({ approval: awaiting })).toEqual({
      status: "rejected",
      code: "APPROVAL_STALE",
    });
    expect(orchestrator.awaitApproval({ approval: awaiting })).toEqual({
      status: "rejected",
      code: "APPROVAL_STALE",
    });
    expect(Reflect.set(awaiting.diffBytes, "0", 0)).toBe(false);
  });
});
