import type {
  TaskWorktreePrepareInput,
  TaskWorktreeReceiptSummary,
} from "../contract.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import type { RepositorySnapshot } from "../git/repository.ts";
import type { PreparedCandidate } from "./candidate.ts";

export function createReceiptSummary(
  authorityId: string,
  input: TaskWorktreePrepareInput,
  repository: RepositorySnapshot,
  branchName: string,
  candidate: PreparedCandidate,
  sandboxWritePaths: readonly string[],
  commandProfiles: readonly unknown[],
): TaskWorktreeReceiptSummary {
  const metrics = candidate.diffReceipt.metrics;
  const message = candidate.commitReceipt.plan.message;
  return Object.freeze({
    authorityId,
    taskId: input.taskId,
    taskEpochDigest: input.taskEpochDigest,
    branchName,
    baseCommitDigest: digestTaskWorktreeValue(repository.head),
    declaredPathDigest: digestTaskWorktreeValue(
      input.changes.map(({ path, operation }) => ({ path, operation })),
    ),
    candidateDigest: candidate.candidateDigest,
    candidateManifestDigest: candidate.candidateManifestDigest,
    baselineTestManifestDigest:
      candidate.protection.baselineManifest.testDigest,
    candidateTestManifestDigest:
      candidate.protection.candidateManifest.testDigest,
    specificationLockDigest:
      candidate.protection.candidateManifest.specificationDigest,
    diff: Object.freeze({
      digest: candidate.diffReceipt.diffDigest,
      changedFiles: metrics.changedFiles,
      addedLines: metrics.addedLines,
      deletedLines: metrics.deletedLines,
      binaryFiles: candidate.diffReceipt.changes.filter(({ binary }) => binary)
        .length,
    }),
    sandbox: Object.freeze({
      mechanism: candidate.sandboxReceipt.mechanism,
      policyDigest: digestTaskWorktreeValue({
        attestation: candidate.sandboxReceipt.receiptDigest,
        writePaths: sandboxWritePaths,
        commandProfiles,
      }),
    }),
    dependencies: Object.freeze({
      digest: candidate.dependencyDigest,
      warningCount: 0,
    }),
    commitPlan: Object.freeze({
      type: message.type,
      scope: message.scope,
      subject: message.text.split("\n", 1)[0] ?? message.description,
      messageDigest: message.messageDigest,
      planDigest: candidate.commitReceipt.plan.planDigest,
    }),
    phasePlanDigest: candidate.phasePlanDigest,
  });
}
