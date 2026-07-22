import { describe, expect, it } from "bun:test";
import {
  createLocalRepositoryLeaseAuthority,
  createWorkspaceTransaction,
  type RepositoryLeaseAuthorityPort,
} from "../src/index.ts";
import {
  ApprovalFixture,
  IsolatedDestinationFixture,
  recoveryRequest,
  writeRequest,
} from "./support.ts";

function rejectingReleaseAuthority(
  rejectedReleaseCount: number,
): RepositoryLeaseAuthorityPort {
  let releaseAttempts = 0;
  let leaseSequence = 0;
  return {
    async acquirePublication(input) {
      leaseSequence += 1;
      const leaseId = `rejecting-release-${leaseSequence}`;
      return {
        status: "acquired",
        lease: {
          ...input,
          leaseId,
          async release() {
            releaseAttempts += 1;
            if (releaseAttempts <= rejectedReleaseCount) {
              throw new Error(`release rejected for ${leaseId}`);
            }
          },
        },
      };
    },
  };
}

describe("durable commitment outcomes", () => {
  it("contains the fifth journal write rejection after target publication", async () => {
    const destination = new IsolatedDestinationFixture();
    destination.writeJournalFailureAt = 5;
    const approval = new ApprovalFixture();
    const transaction = createWorkspaceTransaction({
      destination,
      approvals: approval,
      leases: createLocalRepositoryLeaseAuthority([
        {
          repositoryId: "repo-1",
          rootIdentity: "root-1",
          ownerId: "worker-1",
        },
      ]),
    });

    const result = await transaction.publish(
      writeRequest({ state: "missing" }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "PUBLICATION_RECOVERY_REQUIRED",
      status: "partially-published-recovery-required",
      commitmentSource: "publication",
      publicationStarted: true,
      publicationCommitted: false,
      journalPresent: true,
      recoveryRequired: true,
      journalState: "publishing",
      plannedTargets: 1,
      verifiedPublishedTargets: 1,
      cause: {
        code: "DESTINATION_FAILURE",
        message: "committed journal write failed",
        evidence: { detail: "writeJournal rejected at 5" },
      },
    });
    if (result.ok || result.code !== "PUBLICATION_RECOVERY_REQUIRED") {
      throw new Error("expected publishing-journal recovery evidence");
    }
    expect(destination.writeJournalCount).toBe(5);
    expect(destination.currentText("src/file.ts")).toBe("new");
    expect(destination.renameCount).toBe(1);
    expect(await destination.readJournal()).toBeDefined();

    destination.writeJournalFailureAt = undefined;
    expect(
      await transaction.recover(
        recoveryRequest(approval, result.transactionId),
      ),
    ).toMatchObject({
      ok: true,
      status: "recovered-new",
      publicationCommitted: true,
      recoveryRequired: false,
    });
    expect(destination.renameCount).toBe(1);
    expect(await destination.readJournal()).toBeUndefined();
  });

  it("contains target-two rejection after a partial multi-target publication", async () => {
    const destination = new IsolatedDestinationFixture();
    const first = destination.setFile("src/a.ts", "old-a");
    const second = destination.setFile("src/b.ts", "old-b");
    destination.replaceTargetFailureAt = 2;
    const approval = new ApprovalFixture();
    const transaction = createWorkspaceTransaction({
      destination,
      approvals: approval,
      leases: createLocalRepositoryLeaseAuthority([
        {
          repositoryId: "repo-1",
          rootIdentity: "root-1",
          ownerId: "worker-1",
        },
      ]),
    });
    const result = await transaction.publish({
      version: 1,
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "worker-1",
      approvalReference: "approval-target-two-rejection",
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

    expect(result).toMatchObject({
      ok: false,
      code: "PUBLICATION_RECOVERY_REQUIRED",
      status: "partially-published-recovery-required",
      journalState: "publishing",
      plannedTargets: 2,
      verifiedPublishedTargets: 1,
      cause: {
        code: "DESTINATION_FAILURE",
        evidence: {
          targetPath: "src/b.ts",
          detail: "replaceTarget rejected at 2",
        },
      },
    });
    if (result.ok || result.code !== "PUBLICATION_RECOVERY_REQUIRED") {
      throw new Error("expected partial target recovery evidence");
    }
    expect(destination.currentText("src/a.ts")).toBe("new-a");
    expect(destination.currentText("src/b.ts")).toBe("old-b");
    expect(destination.renameCount).toBe(1);

    destination.replaceTargetFailureAt = undefined;
    expect(
      await transaction.recover(
        recoveryRequest(approval, result.transactionId),
      ),
    ).toMatchObject({ ok: true, status: "recovered-new" });
    expect(destination.currentText("src/a.ts")).toBe("new-a");
    expect(destination.currentText("src/b.ts")).toBe("new-b");
    expect(destination.renameCount).toBe(2);
  });

  it("contains cleanup inspection rejection after durable commit", async () => {
    const destination = new IsolatedDestinationFixture();
    destination.inspectSiblingFailureAt = 2;
    const approval = new ApprovalFixture();
    const transaction = createWorkspaceTransaction({
      destination,
      approvals: approval,
      leases: createLocalRepositoryLeaseAuthority([
        {
          repositoryId: "repo-1",
          rootIdentity: "root-1",
          ownerId: "worker-1",
        },
      ]),
    });
    const result = await transaction.publish(
      writeRequest({ state: "missing" }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "COMMITTED_OPERATION_FAILED",
      status: "committed-recovery-required",
      commitmentSource: "publication",
      publicationCommitted: true,
      journalPresent: true,
      recoveryRequired: true,
      journalState: "cleanup-pending",
      publishedTargets: 1,
      cause: {
        code: "DESTINATION_FAILURE",
        message: "committed sibling cleanup inspection failed",
        evidence: { detail: "inspectSibling rejected at 2" },
      },
    });
    if (result.ok || result.code !== "COMMITTED_OPERATION_FAILED") {
      throw new Error("expected committed cleanup inspection failure");
    }
    expect(destination.currentText("src/file.ts")).toBe("new");
    expect(destination.renameCount).toBe(1);
    expect(await destination.readJournal()).toBeDefined();

    destination.inspectSiblingFailureAt = undefined;
    expect(
      await transaction.recover(
        recoveryRequest(approval, result.transactionId),
      ),
    ).toMatchObject({
      ok: true,
      status: "recovered-new",
      publicationCommitted: true,
      recoveryRequired: false,
    });
    expect(destination.renameCount).toBe(1);
    expect(await destination.readJournal()).toBeUndefined();
  });

  it("reports committed publication when post-commit lease cleanup fails", async () => {
    const destination = new IsolatedDestinationFixture();
    const approval = new ApprovalFixture();
    const transaction = createWorkspaceTransaction({
      destination,
      approvals: approval,
      leases: rejectingReleaseAuthority(1),
    });
    const request = writeRequest({ state: "missing" });

    const result = await transaction.publish(request);
    expect(result).toMatchObject({
      ok: false,
      code: "LEASE_RELEASE_FAILED_AFTER_COMMIT",
      status: "committed-no-recovery-lease-cleanup-failed",
      publicationCommitted: true,
      journalPresent: false,
      recoveryRequired: false,
      journalState: "absent",
      publishedTargets: 1,
      evidence: {
        leaseId: "rejecting-release-1",
        detail: "release rejected for rejecting-release-1",
      },
    });
    if (result.ok || result.code !== "LEASE_RELEASE_FAILED_AFTER_COMMIT") {
      throw new Error("expected the post-commit terminal result");
    }
    if (approval.bindings === undefined) {
      throw new Error("approval bindings were not captured");
    }
    expect(typeof result.transactionId).toBe("string");
    expect(result.requestDigest).toBe(approval.bindings.requestDigest);
    expect(result.targetSetDigest).toBe(approval.bindings.targetSetDigest);
    expect(result.baselineDigest).toBe(approval.bindings.baselineDigest);
    expect(destination.currentText("src/file.ts")).toBe("new");
    expect(destination.renameCount).toBe(1);
    expect(await destination.readJournal()).toBeUndefined();

    expect(await transaction.publish(request)).toMatchObject({
      ok: false,
      code: "TARGET_DRIFT",
    });
    expect(destination.renameCount).toBe(1);
  });

  it("keeps release failure before commit distinct and causal", async () => {
    const destination = new IsolatedDestinationFixture();
    const approval = new ApprovalFixture();
    approval.mismatch = true;
    const transaction = createWorkspaceTransaction({
      destination,
      approvals: approval,
      leases: rejectingReleaseAuthority(1),
    });

    const result = await transaction.publish(
      writeRequest({ state: "missing" }),
    );
    expect(result).toEqual({
      ok: false,
      code: "LEASE_RELEASE_FAILED_BEFORE_COMMIT",
      message: "repository lease cleanup failed before publication committed",
      evidence: {
        leaseId: "rejecting-release-1",
        priorCode: "APPROVAL_BINDING_MISMATCH",
        detail: "release rejected for rejecting-release-1",
      },
    });
    expect(destination.renameCount).toBe(0);
    expect(await destination.readJournal()).toBeUndefined();
  });

  it("preserves cleanup-pending commitment when lease cleanup also fails", async () => {
    const destination = new IsolatedDestinationFixture();
    const baseline = destination.setFile("src/delete.ts", "old-delete");
    const approval = new ApprovalFixture();
    const request = {
      version: 1,
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "worker-1",
      approvalReference: "approval-cleanup-and-lease",
      targets: [
        { path: "src/delete.ts", operation: "delete", expected: baseline },
      ],
    };
    const transaction = createWorkspaceTransaction({
      destination,
      approvals: approval,
      leases: rejectingReleaseAuthority(1),
      crashInjection: {
        async checkpoint(input) {
          if (input.step === "target-published") {
            const [retiredName] = destination.siblings.keys();
            destination.cleanupFailureName = retiredName;
          }
          return false;
        },
      },
    });

    const result = await transaction.publish(request);
    expect(result).toMatchObject({
      ok: false,
      code: "LEASE_RELEASE_FAILED_AFTER_COMMIT",
      status: "committed-recovery-required-lease-cleanup-failed",
      commitmentSource: "publication",
      publicationCommitted: true,
      journalPresent: true,
      recoveryRequired: true,
      journalState: "cleanup-pending",
      publishedTargets: 1,
      priorFailure: {
        code: "CLEANUP_FAILED",
        evidence: { detail: "injected cleanup failure" },
      },
      evidence: {
        leaseId: "rejecting-release-1",
        detail: "release rejected for rejecting-release-1",
      },
    });
    if (result.ok || result.code !== "LEASE_RELEASE_FAILED_AFTER_COMMIT") {
      throw new Error("expected committed cleanup and lease failure evidence");
    }
    expect(destination.currentText("src/delete.ts")).toBeUndefined();
    expect(destination.renameCount).toBe(1);
    expect(await destination.readJournal()).toBeDefined();

    expect(await transaction.publish(request)).toMatchObject({
      ok: false,
      code: "JOURNAL_CONFLICT",
    });
    expect(destination.renameCount).toBe(1);

    destination.cleanupFailureName = undefined;
    const recovery = createWorkspaceTransaction({
      destination,
      approvals: approval,
      leases: createLocalRepositoryLeaseAuthority([
        {
          repositoryId: "repo-1",
          rootIdentity: "root-1",
          ownerId: "worker-1",
        },
      ]),
    });
    expect(
      await recovery.recover(recoveryRequest(approval, result.transactionId)),
    ).toMatchObject({
      ok: true,
      status: "recovered-new",
      publicationCommitted: true,
      journalPresent: false,
      recoveryRequired: false,
    });
    expect(destination.renameCount).toBe(1);
    expect(await destination.readJournal()).toBeUndefined();
  });
});
