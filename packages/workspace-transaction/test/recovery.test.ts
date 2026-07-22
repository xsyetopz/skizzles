import { describe, expect, test } from "bun:test";
import {
  type CrashStep,
  createLocalRepositoryLeaseAuthority,
  createWorkspaceTransaction,
  type RepositoryLeaseAuthorityPort,
} from "../src/index.ts";
import {
  ApprovalFixture,
  digest,
  IsolatedDestinationFixture,
  recoveryRequest,
  writeRequest,
} from "./support.ts";

function transactionHarness(
  fixture: IsolatedDestinationFixture,
  approval: ApprovalFixture,
  crashStep?: CrashStep,
) {
  const transaction = createWorkspaceTransaction({
    destination: fixture,
    approvals: approval,
    leases: createLocalRepositoryLeaseAuthority([
      { repositoryId: "repo-1", rootIdentity: "root-1", ownerId: "worker-1" },
    ]),
    ...(crashStep === undefined
      ? {}
      : {
          crashInjection: {
            async checkpoint(input: { step: CrashStep }) {
              return input.step === crashStep;
            },
          },
        }),
  });
  return transaction;
}

function rejectFirstRelease(): RepositoryLeaseAuthorityPort {
  let releaseAttempts = 0;
  return {
    async acquirePublication(input) {
      return {
        status: "acquired",
        lease: {
          ...input,
          leaseId: `recovery-release-${releaseAttempts + 1}`,
          async release() {
            releaseAttempts += 1;
            if (releaseAttempts === 1) {
              throw new Error("recovery lease release rejected");
            }
          },
        },
      };
    },
  };
}

async function crashAt(step: CrashStep) {
  const fixture = new IsolatedDestinationFixture();
  const baseline = fixture.setFile("src/file.ts", "old");
  const approval = new ApprovalFixture();
  const crashed = await transactionHarness(fixture, approval, step).publish(
    writeRequest(baseline),
  );
  const crashWasCaptured =
    !crashed.ok &&
    (crashed.code === "CRASH_INJECTED" ||
      (crashed.code === "PUBLICATION_RECOVERY_REQUIRED" &&
        crashed.cause.code === "CRASH_INJECTED") ||
      (crashed.code === "COMMITTED_OPERATION_FAILED" &&
        crashed.cause.code === "CRASH_INJECTED"));
  if (!crashWasCaptured || crashed.evidence?.transactionId === undefined) {
    throw new Error("crash did not expose a transaction identity");
  }
  return { fixture, approval, transactionId: crashed.evidence.transactionId };
}

describe("deterministic crash recovery", () => {
  it("reports recovered commitment when its lease cleanup fails", async () => {
    const fixture = new IsolatedDestinationFixture();
    const baseline = fixture.setFile("src/file.ts", "old");
    const approval = new ApprovalFixture();
    const crashed = await transactionHarness(
      fixture,
      approval,
      "journal-committed",
    ).publish(writeRequest(baseline));
    if (
      crashed.ok ||
      crashed.code !== "COMMITTED_OPERATION_FAILED" ||
      crashed.cause.code !== "CRASH_INJECTED"
    ) {
      throw new Error("expected a durable committed crash checkpoint");
    }
    const request = recoveryRequest(approval, crashed.transactionId);
    const recovery = createWorkspaceTransaction({
      destination: fixture,
      approvals: approval,
      leases: rejectFirstRelease(),
    });

    const result = await recovery.recover(request);
    expect(result).toMatchObject({
      ok: false,
      code: "LEASE_RELEASE_FAILED_AFTER_COMMIT",
      status: "committed-no-recovery-lease-cleanup-failed",
      commitmentSource: "recovery",
      publicationCommitted: true,
      journalPresent: false,
      recoveryRequired: false,
      journalState: "absent",
      transactionId: crashed.transactionId,
      requestDigest: crashed.requestDigest,
      targetSetDigest: crashed.targetSetDigest,
      baselineDigest: crashed.baselineDigest,
      publishedTargets: 1,
      evidence: {
        detail: "recovery lease release rejected",
      },
    });
    expect(fixture.currentText("src/file.ts")).toBe("new");
    expect(await fixture.readJournal()).toBeUndefined();
    expect(fixture.renameCount).toBe(1);

    expect(await recovery.recover(request)).toMatchObject({
      ok: true,
      status: "no-journal",
    });
    expect(fixture.renameCount).toBe(1);
  });

  for (const step of [
    "journal-preparing",
    "candidate-created",
    "journal-prepared",
  ] as const) {
    it(`recovers the old state after ${step}`, async () => {
      const { fixture, approval, transactionId } = await crashAt(step);
      const recovered = await transactionHarness(fixture, approval).recover(
        recoveryRequest(approval, transactionId),
      );
      expect(recovered).toMatchObject({ ok: true, status: "recovered-old" });
      expect(fixture.currentText("src/file.ts")).toBe("old");
      expect(fixture.siblings.size).toBe(0);
      expect(await fixture.readJournal()).toBeUndefined();
    });
  }

  for (const step of [
    "journal-publishing",
    "target-published",
    "journal-committed",
  ] as const) {
    it(`recovers the new state after ${step}`, async () => {
      const { fixture, approval, transactionId } = await crashAt(step);
      const recovered = await transactionHarness(fixture, approval).recover(
        recoveryRequest(approval, transactionId),
      );
      expect(recovered).toMatchObject({ ok: true, status: "recovered-new" });
      expect(fixture.currentText("src/file.ts")).toBe("new");
      expect(fixture.siblings.size).toBe(0);
      expect(await fixture.readJournal()).toBeUndefined();
    });
  }

  it("rolls a partially published multi-file target set forward", async () => {
    const fixture = new IsolatedDestinationFixture();
    const first = fixture.setFile("src/a.ts", "old-a");
    const second = fixture.setFile("src/b.ts", "old-b");
    const approval = new ApprovalFixture();
    const crashed = await transactionHarness(
      fixture,
      approval,
      "target-published",
    ).publish({
      version: 1,
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "worker-1",
      approvalReference: "approval-ref-1",
      targets: [
        {
          path: "src/a.ts",
          operation: "write",
          expected: first,
          candidateBytes: [...new TextEncoder().encode("new-a")],
        },
        {
          path: "src/b.ts",
          operation: "write",
          expected: second,
          candidateBytes: [...new TextEncoder().encode("new-b")],
        },
      ],
    });
    expect(crashed).toMatchObject({
      ok: false,
      code: "PUBLICATION_RECOVERY_REQUIRED",
      status: "partially-published-recovery-required",
      journalState: "publishing",
      plannedTargets: 2,
      verifiedPublishedTargets: 1,
      cause: { code: "CRASH_INJECTED" },
    });
    if (crashed.ok || crashed.code !== "PUBLICATION_RECOVERY_REQUIRED") {
      throw new Error("expected an injected partial-publication crash");
    }
    expect(fixture.currentText("src/a.ts")).toBe("new-a");
    expect(fixture.currentText("src/b.ts")).toBe("old-b");

    const recovered = await transactionHarness(fixture, approval).recover(
      recoveryRequest(approval, crashed.transactionId),
    );
    expect(recovered).toMatchObject({ ok: true, status: "recovered-new" });
    expect(fixture.currentText("src/a.ts")).toBe("new-a");
    expect(fixture.currentText("src/b.ts")).toBe("new-b");
  });

  it("rejects recovery replay with different request bindings", async () => {
    const { fixture, approval, transactionId } =
      await crashAt("journal-publishing");
    const request = {
      ...recoveryRequest(approval, transactionId),
      requestDigest: digest("different-request"),
    };
    const recovered = await transactionHarness(fixture, approval).recover(
      request,
    );
    expect(recovered).toMatchObject({
      ok: false,
      code: "JOURNAL_BINDING_MISMATCH",
    });
    expect(fixture.currentText("src/file.ts")).toBe("old");
    expect(fixture.renameCount).toBe(0);
  });

  it("rejects malformed canonical journals without touching targets", async () => {
    const fixture = new IsolatedDestinationFixture();
    fixture.setFile("src/file.ts", "old");
    fixture.corruptJournal(
      new TextEncoder().encode('{"version":1,"version":1}'),
    );
    const approval = new ApprovalFixture();
    const result = await transactionHarness(fixture, approval).recover({
      version: 1,
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "worker-1",
      transactionId: digest("transaction"),
      requestDigest: digest("request"),
      approvalDigest: digest("approval"),
    });
    expect(result).toMatchObject({ ok: false, code: "MALFORMED_JOURNAL" });
    expect(fixture.currentText("src/file.ts")).toBe("old");
    expect(fixture.renameCount).toBe(0);
  });

  it("records cleanup-pending evidence and preserves a rebound foreign artifact", async () => {
    const fixture = new IsolatedDestinationFixture();
    const baseline = fixture.setFile("src/delete.ts", "old-delete");
    const approval = new ApprovalFixture();
    const transaction = transactionHarness(fixture, approval);
    const result = await transaction.publish({
      version: 1,
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "worker-1",
      approvalReference: "approval-ref-1",
      targets: [
        { path: "src/delete.ts", operation: "delete", expected: baseline },
      ],
    });
    expect(result.ok).toBe(true);

    const fixtureWithFailure = new IsolatedDestinationFixture();
    const old = fixtureWithFailure.setFile("src/delete.ts", "old-delete");
    const secondApproval = new ApprovalFixture();
    fixtureWithFailure.cleanupFailureName = "defer";
    const crashingTransaction = createWorkspaceTransaction({
      destination: fixtureWithFailure,
      approvals: secondApproval,
      leases: createLocalRepositoryLeaseAuthority([
        { repositoryId: "repo-1", rootIdentity: "root-1", ownerId: "worker-1" },
      ]),
      crashInjection: {
        async checkpoint(input) {
          if (input.step === "target-published") {
            const [name] = fixtureWithFailure.siblings.keys();
            fixtureWithFailure.cleanupFailureName = name;
          }
          return false;
        },
      },
    });
    const failed = await crashingTransaction.publish({
      version: 1,
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "worker-1",
      approvalReference: "approval-ref-2",
      targets: [{ path: "src/delete.ts", operation: "delete", expected: old }],
    });
    expect(failed).toMatchObject({
      ok: false,
      code: "COMMITTED_OPERATION_FAILED",
      status: "committed-recovery-required",
      journalState: "cleanup-pending",
      cause: { code: "CLEANUP_FAILED" },
      evidence: {
        targetPath: "src/delete.ts",
        detail: "injected cleanup failure",
      },
    });
    if (failed.ok || failed.evidence?.transactionId === undefined) {
      throw new Error("cleanup failure omitted transaction identity");
    }
    const [retiredName] = fixtureWithFailure.siblings.keys();
    if (retiredName === undefined) {
      throw new Error("expected retired sibling");
    }
    fixtureWithFailure.cleanupFailureName = undefined;
    fixtureWithFailure.foreignizeSibling(retiredName);
    const recovered = await transactionHarness(
      fixtureWithFailure,
      secondApproval,
    ).recover(recoveryRequest(secondApproval, failed.evidence.transactionId));
    expect(recovered).toMatchObject({
      ok: false,
      code: "COMMITTED_OPERATION_FAILED",
      status: "committed-recovery-required",
      commitmentSource: "recovery",
      journalState: "cleanup-pending",
      cause: { code: "CLEANUP_FAILED" },
    });
    expect(fixtureWithFailure.siblings.has(retiredName)).toBe(true);
    expect(fixtureWithFailure.currentText("src/delete.ts")).toBeUndefined();
  });
});
