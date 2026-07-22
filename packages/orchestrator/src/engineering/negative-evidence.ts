import {
  digestTaskWorktreeValue,
  isTaskWorktreeReceipt,
} from "@skizzles/task-worktree";
import type { WorkflowReview } from "../workflow/contract.ts";
import type { PreparationState } from "./state.ts";

export function negativeTestEvidenceMatches(
  state: PreparationState,
  review: WorkflowReview,
): boolean {
  if (
    state.prepared === null ||
    !isTaskWorktreeReceipt(review.taskWorktreeReceipt)
  ) {
    return false;
  }
  const bindings = state.input.profile.negativeTestCommands;
  const expectedPaths = bindings
    .flatMap(({ testPaths }) => testPaths)
    .sort((left, right) => left.localeCompare(right));
  const observedPaths = state.prepared.receipt.observedNegativeTests
    .map(({ testPath }) => testPath)
    .sort((left, right) => left.localeCompare(right));
  if (
    expectedPaths.length !== observedPaths.length ||
    expectedPaths.some((path, index) => path !== observedPaths[index]) ||
    !bindings.every(({ profileId }) =>
      review.executedProfileIds.includes(profileId),
    )
  ) {
    return false;
  }
  const declaredPathDigest = digestTaskWorktreeValue(
    state.prepared.artifacts.map(({ path }) => ({
      path,
      operation: "write",
    })),
  );
  const candidateDigest = digestTaskWorktreeValue(
    state.prepared.artifacts.map((artifact, index) => ({
      path: artifact.path,
      bytes: [...(state.prepared?.candidateBytes[index] ?? [])],
    })),
  );
  return (
    review.taskWorktreeReceipt.declaredPathDigest === declaredPathDigest &&
    review.taskWorktreeReceipt.candidateDigest === candidateDigest
  );
}
