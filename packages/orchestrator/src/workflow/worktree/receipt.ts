import {
  isTaskWorktreeReceipt,
  type TaskWorktreeReceipt,
} from "@skizzles/task-worktree";

export function createWorktreeMaterial(
  receipt: TaskWorktreeReceipt,
  executedProfileIds: readonly string[],
) {
  return Object.freeze({
    receiptDigest: receipt.receiptDigest,
    taskEpochDigest: receipt.taskEpochDigest,
    candidateDigest: receipt.candidateDigest,
    candidateManifestDigest: receipt.candidateManifestDigest,
    baselineTestManifestDigest: receipt.baselineTestManifestDigest,
    candidateTestManifestDigest: receipt.candidateTestManifestDigest,
    specificationLockDigest: receipt.specificationLockDigest,
    declaredPathDigest: receipt.declaredPathDigest,
    commitMessageDigest: receipt.commitPlan.messageDigest,
    executedProfileIds,
  });
}

export function sameTaskWorktreeBinding(
  expected: TaskWorktreeReceipt,
  actual: TaskWorktreeReceipt,
): boolean {
  return (
    isTaskWorktreeReceipt(expected) &&
    isTaskWorktreeReceipt(actual) &&
    expected.authorityId === actual.authorityId &&
    expected.taskId === actual.taskId &&
    expected.taskEpochDigest === actual.taskEpochDigest &&
    expected.branchName === actual.branchName &&
    expected.baseCommitDigest === actual.baseCommitDigest &&
    expected.declaredPathDigest === actual.declaredPathDigest &&
    expected.candidateDigest === actual.candidateDigest &&
    expected.candidateManifestDigest === actual.candidateManifestDigest &&
    expected.baselineTestManifestDigest === actual.baselineTestManifestDigest &&
    expected.candidateTestManifestDigest ===
      actual.candidateTestManifestDigest &&
    expected.specificationLockDigest === actual.specificationLockDigest &&
    expected.diff.digest === actual.diff.digest &&
    expected.sandbox.policyDigest === actual.sandbox.policyDigest &&
    expected.dependencies.digest === actual.dependencies.digest &&
    expected.commitPlan.messageDigest === actual.commitPlan.messageDigest &&
    expected.commitPlan.planDigest === actual.commitPlan.planDigest &&
    expected.phasePlanDigest === actual.phasePlanDigest
  );
}
