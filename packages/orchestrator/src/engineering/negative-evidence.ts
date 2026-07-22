import type { EngineeringReview } from "./contract.ts";
import type { PreparationState } from "./state.ts";

export function negativeTestEvidenceMatches(
  state: PreparationState,
  audits: EngineeringReview["commandAudits"],
): boolean {
  if (state.prepared === null) return false;
  const bindings = state.input.profile.negativeTestCommands;
  const expectedPaths = bindings
    .flatMap(({ testPaths }) => testPaths)
    .sort((left, right) => left.localeCompare(right));
  const observedPaths = state.prepared.receipt.observedNegativeTests
    .map(({ testPath }) => testPath)
    .sort((left, right) => left.localeCompare(right));
  if (
    expectedPaths.length !== observedPaths.length ||
    expectedPaths.some((path, index) => path !== observedPaths[index])
  ) {
    return false;
  }
  return bindings.every(({ profileId, testPaths }) => {
    const audit = audits.find((candidate) => candidate.profileId === profileId);
    return (
      audit !== undefined &&
      commandScopeMatchesPrepared(state, audit) &&
      testPaths.every((path) => audit.declaredTargetPaths.includes(path))
    );
  });
}

function commandScopeMatchesPrepared(
  state: PreparationState,
  audit: EngineeringReview["commandAudits"][number],
): boolean {
  if (state.prepared === null) return false;
  const expected = [...state.prepared.receipt.targetReceipts].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
  const actual = [...audit.scope.targets].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return (
    actual.length === expected.length &&
    actual.every((target, index) => {
      const receipt = expected[index];
      return (
        receipt !== undefined &&
        target.path === receipt.path &&
        target.operation === "write" &&
        target.candidateDigest === receipt.candidateDigest
      );
    })
  );
}
