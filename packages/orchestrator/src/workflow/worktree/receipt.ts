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
    candidateDigest: receipt.candidateDigest,
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
    expected.branchName === actual.branchName &&
    expected.baseCommitDigest === actual.baseCommitDigest &&
    expected.declaredPathDigest === actual.declaredPathDigest &&
    expected.candidateDigest === actual.candidateDigest &&
    expected.diff.digest === actual.diff.digest &&
    expected.sandbox.policyDigest === actual.sandbox.policyDigest &&
    expected.dependencies.digest === actual.dependencies.digest &&
    expected.commitPlan.messageDigest === actual.commitPlan.messageDigest &&
    expected.commitPlan.planDigest === actual.commitPlan.planDigest &&
    expected.phasePlanDigest === actual.phasePlanDigest
  );
}
