import type {
  PostCommitLeaseCleanupFailure,
  PostPublicationLeaseCleanupFailure,
  PublicationResult,
  RecoveryResult,
  RepositoryIdentity,
  TransactionFailure,
} from "./contracts.ts";
import { digestValue } from "./digest.ts";
import {
  acquireLease,
  cleanupOwnedSiblings,
  exactRepository,
  failure,
  isFailure,
  publishOne,
  validateAllTargets,
  validateJournalSnapshot,
  type WorkspaceTransaction,
  type WorkspaceTransactionConfig,
  writeJournal,
} from "./engine.ts";
import { decodeJournal, transitionJournal } from "./journal.ts";
import {
  committedFailure,
  finalizeCleanup,
  publicationRecoveryFailure,
} from "./lifecycle/cleanup.ts";
import { executePublication } from "./publication.ts";
import {
  parseRecoveryRequest,
  type RecoveryRequest,
} from "./recovery-request.ts";
import { parseTransactionRequest } from "./request.ts";

export type {
  WorkspaceTransaction,
  WorkspaceTransactionConfig,
} from "./engine.ts";

async function executeRecovery(
  config: WorkspaceTransactionConfig,
  request: RecoveryRequest,
  repository: RepositoryIdentity,
): Promise<RecoveryResult> {
  const snapshot = await config.destination.readJournal(repository);
  if (snapshot === undefined) {
    return { ok: true, status: "no-journal" };
  }
  const invalidSnapshot = validateJournalSnapshot(
    snapshot,
    undefined,
    repository,
  );
  if (invalidSnapshot !== undefined) {
    return invalidSnapshot;
  }
  const decoded = decodeJournal(snapshot.bytes);
  if (decoded.ok === false) {
    return decoded;
  }
  let journal = decoded.journal;
  const expectedTransactionId = digestValue({
    requestDigest: request.requestDigest,
    approvalDigest: request.approvalDigest,
  });
  if (
    journal.transactionId !== request.transactionId ||
    journal.transactionId !== expectedTransactionId ||
    journal.approvalDigest !== request.approvalDigest ||
    journal.bindings.repositoryId !== request.repositoryId ||
    journal.bindings.rootIdentity !== request.rootIdentity ||
    journal.bindings.ownerId !== request.ownerId ||
    journal.bindings.requestDigest !== request.requestDigest
  ) {
    return failure(
      "JOURNAL_BINDING_MISMATCH",
      "recovery request does not own the active journal",
      {
        transactionId: request.transactionId,
        journalState: journal.state,
        requestDigest: request.requestDigest,
      },
    );
  }
  if (journal.state === "preparing" || journal.state === "prepared") {
    const current = await config.destination.inspectTargets(
      repository,
      journal.targets.map((target) => target.path),
    );
    const drift = validateAllTargets(current, journal.targets, repository);
    if (drift !== undefined) {
      return drift;
    }
    const cleanupFailure = await cleanupOwnedSiblings(
      config.destination,
      repository,
      journal,
    );
    if (cleanupFailure !== undefined) {
      return cleanupFailure;
    }
    await config.destination.removeJournal(repository, snapshot.revision);
    return {
      ok: true,
      status: "recovered-old",
      transactionId: journal.transactionId,
      journalState: journal.state,
    };
  }
  const durableJournalState =
    journal.state === "committed" || journal.state === "cleanup-pending"
      ? journal.state
      : undefined;
  let verifiedPublishedTargets = 0;
  try {
    for (const target of journal.targets) {
      const publishFailure = await publishOne(
        config.destination,
        repository,
        journal,
        target,
      );
      if (publishFailure !== undefined) {
        return durableJournalState === undefined
          ? publicationRecoveryFailure(
              journal,
              "recovery",
              verifiedPublishedTargets,
              publishFailure,
            )
          : committedFailure(
              journal,
              durableJournalState,
              "recovery",
              publishFailure,
            );
      }
      verifiedPublishedTargets += 1;
    }
  } catch (error) {
    if (durableJournalState !== undefined) {
      return committedFailure(
        journal,
        durableJournalState,
        "recovery",
        failure("DESTINATION_FAILURE", "committed target inspection failed", {
          transactionId: journal.transactionId,
          detail:
            error instanceof Error
              ? error.message
              : "unknown committed target inspection failure",
        }),
      );
    }
    return publicationRecoveryFailure(
      journal,
      "recovery",
      verifiedPublishedTargets,
      failure("DESTINATION_FAILURE", "publishing target inspection failed", {
        transactionId: journal.transactionId,
        detail:
          error instanceof Error
            ? error.message
            : "unknown publishing target inspection failure",
      }),
    );
  }
  let finalSnapshot = snapshot;
  if (journal.state === "publishing") {
    const publishingJournal = journal;
    const committedJournal = transitionJournal(journal, "committed");
    let updated: Awaited<ReturnType<typeof writeJournal>>;
    try {
      updated = await writeJournal(
        config.destination,
        repository,
        committedJournal,
        snapshot,
      );
    } catch (error) {
      return publicationRecoveryFailure(
        publishingJournal,
        "recovery",
        verifiedPublishedTargets,
        failure(
          "DESTINATION_FAILURE",
          "recovery committed journal write failed",
          {
            transactionId: journal.transactionId,
            detail:
              error instanceof Error
                ? error.message
                : "unknown recovery committed journal failure",
          },
        ),
      );
    }
    if (isFailure(updated)) {
      return publicationRecoveryFailure(
        publishingJournal,
        "recovery",
        verifiedPublishedTargets,
        updated,
      );
    }
    journal = committedJournal;
    finalSnapshot = updated;
  }
  const cleanupFailure = await finalizeCleanup(
    config,
    repository,
    journal,
    finalSnapshot,
    "recovery",
  );
  if (cleanupFailure !== undefined) {
    return cleanupFailure;
  }
  return {
    ok: true,
    status: "recovered-new",
    publicationCommitted: true,
    journalPresent: false,
    recoveryRequired: false,
    transactionId: journal.transactionId,
    requestDigest: journal.bindings.requestDigest,
    targetSetDigest: journal.bindings.targetSetDigest,
    baselineDigest: journal.bindings.baselineDigest,
    publishedTargets: journal.targets.length,
    journalState:
      journal.state === "cleanup-pending" ? "cleanup-pending" : "committed",
  };
}

type CommitmentSnapshot = Readonly<{
  commitmentSource: "publication" | "recovery";
  transactionId: string;
  requestDigest: string;
  targetSetDigest: string;
  baselineDigest: string;
  publishedTargets: number;
  journalPresent: boolean;
  recoveryRequired: boolean;
  journalState: "absent" | "committed" | "cleanup-pending";
  priorFailure?: TransactionFailure;
}>;

function commitmentSnapshot(
  result: PublicationResult | RecoveryResult,
): CommitmentSnapshot | undefined {
  if (result.ok && result.status === "committed") {
    return {
      commitmentSource: "publication",
      transactionId: result.transactionId,
      requestDigest: result.requestDigest,
      targetSetDigest: result.targetSetDigest,
      baselineDigest: result.baselineDigest,
      publishedTargets: result.publishedTargets,
      journalPresent: false,
      recoveryRequired: false,
      journalState: "absent",
    };
  }
  if (result.ok && result.status === "recovered-new") {
    return {
      commitmentSource: "recovery",
      transactionId: result.transactionId,
      requestDigest: result.requestDigest,
      targetSetDigest: result.targetSetDigest,
      baselineDigest: result.baselineDigest,
      publishedTargets: result.publishedTargets,
      journalPresent: false,
      recoveryRequired: false,
      journalState: "absent",
    };
  }
  if (!result.ok && result.code === "COMMITTED_OPERATION_FAILED") {
    return {
      commitmentSource: result.commitmentSource,
      transactionId: result.transactionId,
      requestDigest: result.requestDigest,
      targetSetDigest: result.targetSetDigest,
      baselineDigest: result.baselineDigest,
      publishedTargets: result.publishedTargets,
      journalPresent: true,
      recoveryRequired: true,
      journalState: result.journalState,
      priorFailure: result.cause,
    };
  }
}

function priorFailureCode(
  result: PublicationResult | RecoveryResult,
): TransactionFailure["code"] | undefined {
  if (
    result.ok ||
    result.code === "COMMITTED_OPERATION_FAILED" ||
    result.code === "LEASE_RELEASE_FAILED_AFTER_COMMIT" ||
    result.code === "PUBLICATION_RECOVERY_REQUIRED" ||
    result.code === "LEASE_RELEASE_FAILED_AFTER_PUBLICATION_STARTED"
  ) {
    return;
  }
  return result.code;
}

async function withRepositoryLease(
  config: WorkspaceTransactionConfig,
  repositoryId: string,
  rootIdentity: string,
  ownerId: string,
  operation: (repository: RepositoryIdentity) => Promise<PublicationResult>,
): Promise<PublicationResult>;
async function withRepositoryLease(
  config: WorkspaceTransactionConfig,
  repositoryId: string,
  rootIdentity: string,
  ownerId: string,
  operation: (repository: RepositoryIdentity) => Promise<RecoveryResult>,
): Promise<RecoveryResult>;
async function withRepositoryLease(
  config: WorkspaceTransactionConfig,
  repositoryId: string,
  rootIdentity: string,
  ownerId: string,
  operation: (
    repository: RepositoryIdentity,
  ) => Promise<PublicationResult | RecoveryResult>,
): Promise<PublicationResult | RecoveryResult> {
  try {
    const captured = await config.destination.captureRepository(repositoryId);
    if (!exactRepository(captured, rootIdentity, repositoryId)) {
      return failure(
        "REPOSITORY_REBOUND",
        "repository identity does not match the request",
      );
    }
    const lease = await acquireLease(
      config.leases,
      repositoryId,
      rootIdentity,
      ownerId,
    );
    if (isFailure(lease)) {
      return lease;
    }
    let result: PublicationResult | RecoveryResult;
    try {
      const recaptured =
        await config.destination.captureRepository(repositoryId);
      result =
        exactRepository(recaptured, rootIdentity, repositoryId) &&
        recaptured.deviceId === captured.deviceId
          ? await operation(recaptured)
          : failure(
              "REPOSITORY_REBOUND",
              "repository identity changed while acquiring its lease",
            );
    } catch (error) {
      result = failure("DESTINATION_FAILURE", "transaction authority failed", {
        detail:
          error instanceof Error ? error.message : "unknown authority failure",
      });
    }
    try {
      await lease.release();
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "unknown lease release failure";
      if (!result.ok && result.code === "PUBLICATION_RECOVERY_REQUIRED") {
        const terminal: PostPublicationLeaseCleanupFailure = {
          ok: false,
          code: "LEASE_RELEASE_FAILED_AFTER_PUBLICATION_STARTED",
          status: "partially-published-recovery-required-lease-cleanup-failed",
          message:
            "publication started, requires recovery, and lease cleanup failed",
          commitmentSource: result.commitmentSource,
          publicationStarted: true,
          publicationCommitted: false,
          journalPresent: true,
          recoveryRequired: true,
          journalState: "publishing",
          transactionId: result.transactionId,
          requestDigest: result.requestDigest,
          targetSetDigest: result.targetSetDigest,
          baselineDigest: result.baselineDigest,
          plannedTargets: result.plannedTargets,
          verifiedPublishedTargets: result.verifiedPublishedTargets,
          evidence: {
            transactionId: result.transactionId,
            requestDigest: result.requestDigest,
            leaseId: lease.leaseId,
            detail,
          },
          priorFailure: result.cause,
        };
        return terminal;
      }
      const commitment = commitmentSnapshot(result);
      if (commitment !== undefined) {
        const common = {
          ok: false,
          code: "LEASE_RELEASE_FAILED_AFTER_COMMIT",
          message:
            "publication committed, but the repository lease cleanup failed",
          commitmentSource: commitment.commitmentSource,
          publicationCommitted: true,
          transactionId: commitment.transactionId,
          requestDigest: commitment.requestDigest,
          targetSetDigest: commitment.targetSetDigest,
          baselineDigest: commitment.baselineDigest,
          publishedTargets: commitment.publishedTargets,
          evidence: {
            transactionId: commitment.transactionId,
            requestDigest: commitment.requestDigest,
            leaseId: lease.leaseId,
            detail,
          },
          ...(commitment.priorFailure === undefined
            ? {}
            : { priorFailure: commitment.priorFailure }),
        } as const;
        const terminal: PostCommitLeaseCleanupFailure =
          commitment.recoveryRequired
            ? {
                ...common,
                status: "committed-recovery-required-lease-cleanup-failed",
                journalPresent: true,
                recoveryRequired: true,
                journalState:
                  commitment.journalState === "cleanup-pending"
                    ? "cleanup-pending"
                    : "committed",
              }
            : {
                ...common,
                status: "committed-no-recovery-lease-cleanup-failed",
                journalPresent: false,
                recoveryRequired: false,
                journalState: "absent",
              };
        return terminal;
      }
      const priorCode = priorFailureCode(result);
      return failure(
        "LEASE_RELEASE_FAILED_BEFORE_COMMIT",
        "repository lease cleanup failed before publication committed",
        {
          leaseId: lease.leaseId,
          ...(priorCode === undefined ? {} : { priorCode }),
          detail,
        },
      );
    }
    return result;
  } catch (error) {
    return failure("DESTINATION_FAILURE", "transaction authority failed", {
      detail:
        error instanceof Error ? error.message : "unknown authority failure",
    });
  }
}

export function createWorkspaceTransaction(
  config: WorkspaceTransactionConfig,
): WorkspaceTransaction {
  return {
    async publish(input): Promise<PublicationResult> {
      let parsed: ReturnType<typeof parseTransactionRequest>;
      try {
        parsed = parseTransactionRequest(input);
      } catch {
        return failure(
          "MALFORMED_INPUT",
          "transaction request could not be safely inspected",
        );
      }
      if (parsed.ok === false) {
        return parsed;
      }
      return withRepositoryLease(
        config,
        parsed.request.repositoryId,
        parsed.request.rootIdentity,
        parsed.request.ownerId,
        (repository) => executePublication(config, parsed.request, repository),
      );
    },

    async recover(input): Promise<RecoveryResult> {
      let parsed: ReturnType<typeof parseRecoveryRequest>;
      try {
        parsed = parseRecoveryRequest(input);
      } catch {
        return failure(
          "MALFORMED_INPUT",
          "recovery request could not be safely inspected",
        );
      }
      if (parsed.ok === false) {
        return parsed;
      }
      return withRepositoryLease(
        config,
        parsed.request.repositoryId,
        parsed.request.rootIdentity,
        parsed.request.ownerId,
        (repository) => executeRecovery(config, parsed.request, repository),
      );
    },
  };
}
