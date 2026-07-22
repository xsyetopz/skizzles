import type { PublicationResult, RepositoryIdentity } from "./contracts.ts";
import { isDigest } from "./digest.ts";
import {
  bindingsEqual,
  checkpoint,
  expectedOwnership,
  failure,
  isFailure,
  publishOne,
  validateAllTargets,
  validateSibling,
  type WorkspaceTransactionConfig,
  writeJournal,
} from "./engine.ts";
import {
  bindJournalCandidate,
  createJournal,
  transitionJournal,
} from "./journal.ts";
import {
  committedFailure,
  finalizeCleanup,
  publicationRecoveryFailure,
} from "./lifecycle/cleanup.ts";
import type { TransactionRequest } from "./request.ts";

export async function executePublication(
  config: WorkspaceTransactionConfig,
  request: TransactionRequest,
  repository: RepositoryIdentity,
): Promise<PublicationResult> {
  const existingJournal = await config.destination.readJournal(repository);
  if (existingJournal !== undefined) {
    return failure(
      "JOURNAL_CONFLICT",
      "repository has an unfinished transaction journal",
    );
  }
  const initial = await config.destination.inspectTargets(
    repository,
    request.targets.map((target) => target.path),
  );
  const invalidInitial = validateAllTargets(
    initial,
    request.targets,
    repository,
  );
  if (invalidInitial !== undefined) {
    return invalidInitial;
  }
  const approval = await config.approvals.verifyAndConsume(
    request.approvalBindings,
  );
  if (approval.status === "already-consumed") {
    return failure("APPROVAL_REPLAYED", "approval has already been consumed", {
      requestDigest: request.requestDigest,
    });
  }
  if (approval.status !== "approved") {
    return failure(
      "APPROVAL_REJECTED",
      "approval authority rejected the transaction",
      {
        requestDigest: request.requestDigest,
      },
    );
  }
  if (
    !(
      isDigest(approval.approvalDigest) &&
      bindingsEqual(approval.bindings, request.approvalBindings)
    )
  ) {
    return failure(
      "APPROVAL_BINDING_MISMATCH",
      "approval authority returned different transaction bindings",
      {
        requestDigest: request.requestDigest,
      },
    );
  }
  let journal = createJournal(request, approval.approvalDigest);
  let journalSnapshot = await writeJournal(
    config.destination,
    repository,
    journal,
    undefined,
  );
  if (isFailure(journalSnapshot)) {
    return journalSnapshot;
  }
  let injected = await checkpoint(
    config.crashInjection,
    "journal-preparing",
    journal.transactionId,
  );
  if (injected !== undefined) {
    return injected;
  }
  for (const target of request.targets) {
    if (target.operation !== "write") {
      continue;
    }
    const journalTarget = journal.targets.find(
      (entry) => entry.path === target.path,
    );
    const candidate = journalTarget?.candidate;
    if (
      journalTarget === undefined ||
      candidate === null ||
      candidate === undefined
    ) {
      return failure("MALFORMED_JOURNAL", "candidate binding is missing", {
        targetPath: target.path,
      });
    }
    const ownership = expectedOwnership(journal, journalTarget);
    const sibling = await config.destination.createSibling(
      repository,
      candidate.name,
      target.candidateBytes,
      ownership,
    );
    const invalid = validateSibling(
      sibling,
      candidate.name,
      ownership,
      repository,
      {
        contentDigest: candidate.contentDigest,
        byteLength: candidate.byteLength,
      },
    );
    if (invalid !== undefined) {
      return invalid;
    }
    journal = bindJournalCandidate(
      journal,
      target.path,
      sibling.identity,
      sibling.deviceId,
    );
    journalSnapshot = await writeJournal(
      config.destination,
      repository,
      journal,
      journalSnapshot,
    );
    if (isFailure(journalSnapshot)) {
      return journalSnapshot;
    }
    injected = await checkpoint(
      config.crashInjection,
      "candidate-created",
      journal.transactionId,
      target.path,
    );
    if (injected !== undefined) {
      return injected;
    }
  }
  journal = transitionJournal(journal, "prepared");
  journalSnapshot = await writeJournal(
    config.destination,
    repository,
    journal,
    journalSnapshot,
  );
  if (isFailure(journalSnapshot)) {
    return journalSnapshot;
  }
  injected = await checkpoint(
    config.crashInjection,
    "journal-prepared",
    journal.transactionId,
  );
  if (injected !== undefined) {
    return injected;
  }
  const rechecked = await config.destination.inspectTargets(
    repository,
    request.targets.map((target) => target.path),
  );
  const drift = validateAllTargets(rechecked, request.targets, repository);
  if (drift !== undefined) {
    return drift;
  }
  journal = transitionJournal(journal, "publishing");
  journalSnapshot = await writeJournal(
    config.destination,
    repository,
    journal,
    journalSnapshot,
  );
  if (isFailure(journalSnapshot)) {
    return journalSnapshot;
  }
  injected = await checkpoint(
    config.crashInjection,
    "journal-publishing",
    journal.transactionId,
  );
  if (injected !== undefined) {
    return injected;
  }
  let verifiedPublishedTargets = 0;
  for (const target of journal.targets) {
    let publishFailure: Awaited<ReturnType<typeof publishOne>>;
    try {
      publishFailure = await publishOne(
        config.destination,
        repository,
        journal,
        target,
      );
    } catch (error) {
      return publicationRecoveryFailure(
        journal,
        "publication",
        verifiedPublishedTargets,
        failure("DESTINATION_FAILURE", "target publication authority failed", {
          transactionId: journal.transactionId,
          targetPath: target.path,
          detail:
            error instanceof Error
              ? error.message
              : "unknown target publication failure",
        }),
      );
    }
    if (publishFailure !== undefined) {
      return publicationRecoveryFailure(
        journal,
        "publication",
        verifiedPublishedTargets,
        publishFailure,
      );
    }
    verifiedPublishedTargets += 1;
    try {
      injected = await checkpoint(
        config.crashInjection,
        "target-published",
        journal.transactionId,
        target.path,
      );
    } catch (error) {
      return publicationRecoveryFailure(
        journal,
        "publication",
        verifiedPublishedTargets,
        failure("DESTINATION_FAILURE", "published-target checkpoint failed", {
          transactionId: journal.transactionId,
          targetPath: target.path,
          detail:
            error instanceof Error
              ? error.message
              : "unknown published-target checkpoint failure",
        }),
      );
    }
    if (injected !== undefined) {
      return publicationRecoveryFailure(
        journal,
        "publication",
        verifiedPublishedTargets,
        injected,
      );
    }
  }
  const publishingJournal = journal;
  const committedJournal = transitionJournal(journal, "committed");
  let committedSnapshot: Awaited<ReturnType<typeof writeJournal>>;
  try {
    committedSnapshot = await writeJournal(
      config.destination,
      repository,
      committedJournal,
      journalSnapshot,
    );
  } catch (error) {
    return publicationRecoveryFailure(
      publishingJournal,
      "publication",
      verifiedPublishedTargets,
      failure("DESTINATION_FAILURE", "committed journal write failed", {
        transactionId: journal.transactionId,
        detail:
          error instanceof Error
            ? error.message
            : "unknown committed journal write failure",
      }),
    );
  }
  if (isFailure(committedSnapshot)) {
    return publicationRecoveryFailure(
      publishingJournal,
      "publication",
      verifiedPublishedTargets,
      committedSnapshot,
    );
  }
  journal = committedJournal;
  journalSnapshot = committedSnapshot;
  try {
    injected = await checkpoint(
      config.crashInjection,
      "journal-committed",
      journal.transactionId,
    );
  } catch (error) {
    return committedFailure(
      journal,
      "committed",
      "publication",
      failure("DESTINATION_FAILURE", "committed checkpoint failed", {
        transactionId: journal.transactionId,
        detail:
          error instanceof Error
            ? error.message
            : "unknown committed checkpoint failure",
      }),
    );
  }
  if (injected !== undefined) {
    return committedFailure(journal, "committed", "publication", injected);
  }
  const cleanupFailure = await finalizeCleanup(
    config,
    repository,
    journal,
    journalSnapshot,
    "publication",
  );
  if (cleanupFailure !== undefined) {
    return cleanupFailure;
  }
  return {
    ok: true,
    status: "committed",
    transactionId: journal.transactionId,
    requestDigest: request.requestDigest,
    targetSetDigest: request.targetSetDigest,
    baselineDigest: request.baselineDigest,
    publishedTargets: journal.targets.length,
  };
}
