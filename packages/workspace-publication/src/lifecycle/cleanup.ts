import {
  checkpoint,
  cleanupOwnedSiblings,
  failure,
  isFailure,
  type WorkspaceTransactionConfig,
  writeJournal,
} from "../execution/engine.ts";
import {
  type TransactionJournal,
  transitionJournal,
} from "../execution/journal.ts";
import type {
  CommittedTransactionFailure,
  JournalSnapshot,
  PublicationRecoveryRequiredFailure,
  RepositoryIdentity,
  TransactionFailure,
} from "../protocol/contracts.ts";

export async function finalizeCleanup(
  config: WorkspaceTransactionConfig,
  repository: RepositoryIdentity,
  journal: TransactionJournal,
  journalSnapshot: JournalSnapshot,
  commitmentSource: "publication" | "recovery",
): Promise<CommittedTransactionFailure | undefined> {
  let cleanupFailure: TransactionFailure | undefined;
  try {
    cleanupFailure = await cleanupOwnedSiblings(
      config.destination,
      repository,
      journal,
    );
  } catch (error) {
    cleanupFailure = failure(
      "DESTINATION_FAILURE",
      "committed sibling cleanup inspection failed",
      {
        transactionId: journal.transactionId,
        detail:
          error instanceof Error
            ? error.message
            : "unknown cleanup inspection failure",
      },
    );
  }
  if (cleanupFailure !== undefined) {
    const pending = transitionJournal(journal, "cleanup-pending");
    let updated: Awaited<ReturnType<typeof writeJournal>>;
    try {
      updated = await writeJournal(
        config.destination,
        repository,
        pending,
        journalSnapshot,
      );
    } catch (error) {
      return committedFailure(
        journal,
        journal.state === "cleanup-pending" ? "cleanup-pending" : "committed",
        commitmentSource,
        failure("DESTINATION_FAILURE", "cleanup-pending journal write failed", {
          transactionId: journal.transactionId,
          detail:
            error instanceof Error
              ? error.message
              : "unknown cleanup-pending journal failure",
        }),
      );
    }
    if (isFailure(updated)) {
      return committedFailure(
        journal,
        journal.state === "cleanup-pending" ? "cleanup-pending" : "committed",
        commitmentSource,
        updated,
      );
    }
    let injected: TransactionFailure | undefined;
    try {
      injected = await checkpoint(
        config.crashInjection,
        "journal-cleanup-pending",
        journal.transactionId,
      );
    } catch (error) {
      injected = failure(
        "DESTINATION_FAILURE",
        "cleanup-pending checkpoint failed",
        {
          transactionId: journal.transactionId,
          detail:
            error instanceof Error
              ? error.message
              : "unknown cleanup checkpoint failure",
        },
      );
    }
    return committedFailure(
      pending,
      "cleanup-pending",
      commitmentSource,
      injected ?? cleanupFailure,
    );
  }
  try {
    await config.destination.removeJournal(
      repository,
      journalSnapshot.revision,
    );
  } catch (error) {
    return committedFailure(
      journal,
      journal.state === "cleanup-pending" ? "cleanup-pending" : "committed",
      commitmentSource,
      failure("DESTINATION_FAILURE", "committed journal removal failed", {
        transactionId: journal.transactionId,
        detail:
          error instanceof Error
            ? error.message
            : "unknown journal removal failure",
      }),
    );
  }
  return undefined;
}

export function committedFailure(
  journal: TransactionJournal,
  journalState: "committed" | "cleanup-pending",
  commitmentSource: "publication" | "recovery",
  cause: TransactionFailure,
): CommittedTransactionFailure {
  return {
    ok: false,
    code: "COMMITTED_OPERATION_FAILED",
    status: "committed-recovery-required",
    message: "publication is committed and requires deterministic recovery",
    commitmentSource,
    publicationCommitted: true,
    journalPresent: true,
    recoveryRequired: true,
    journalState,
    transactionId: journal.transactionId,
    requestDigest: journal.bindings.requestDigest,
    targetSetDigest: journal.bindings.targetSetDigest,
    baselineDigest: journal.bindings.baselineDigest,
    publishedTargets: journal.targets.length,
    cause,
    evidence: cause.evidence ?? {
      transactionId: journal.transactionId,
      requestDigest: journal.bindings.requestDigest,
      detail: cause.message,
    },
  };
}

export function publicationRecoveryFailure(
  journal: TransactionJournal,
  commitmentSource: "publication" | "recovery",
  verifiedPublishedTargets: number,
  cause: TransactionFailure,
): PublicationRecoveryRequiredFailure {
  return {
    ok: false,
    code: "PUBLICATION_RECOVERY_REQUIRED",
    status: "partially-published-recovery-required",
    message: "publication started and requires deterministic recovery",
    commitmentSource,
    publicationStarted: true,
    publicationCommitted: false,
    journalPresent: true,
    recoveryRequired: true,
    journalState: "publishing",
    transactionId: journal.transactionId,
    requestDigest: journal.bindings.requestDigest,
    targetSetDigest: journal.bindings.targetSetDigest,
    baselineDigest: journal.bindings.baselineDigest,
    plannedTargets: journal.targets.length,
    verifiedPublishedTargets,
    cause,
    evidence: cause.evidence ?? {
      transactionId: journal.transactionId,
      requestDigest: journal.bindings.requestDigest,
      detail: cause.message,
    },
  };
}
