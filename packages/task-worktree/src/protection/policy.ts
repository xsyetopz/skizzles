import { types } from "node:util";
import type {
  TaskWorktreeConfig,
  TaskWorktreePrepareInput,
} from "../contract.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import { isTaskWorktreeDigest } from "../lifecycle/configuration/actions.ts";
import type { ProtectedCandidateState, ProtectedManifest } from "./contract.ts";
import { captureProtectedManifest } from "./manifest.ts";
import type { TaskWorktreeProtectedPathAuthorizationRequest } from "./public-contract.ts";

export async function authorizeProtectedCandidate(
  root: string,
  authorityId: string,
  input: TaskWorktreePrepareInput,
  policy: TaskWorktreeConfig["protectedPaths"],
): Promise<ProtectedCandidateState | undefined> {
  const baselineManifest = await captureProtectedManifest(root, policy);
  if (baselineManifest === undefined) return;
  const classified = classifyChanges(input, policy);
  if (classified === undefined) return;
  const declaredPathDigest = digestTaskWorktreeValue(
    input.changes.map(({ path, operation }) => ({ path, operation })),
  );
  const material = Object.freeze({
    authorityId: policy.policyId,
    taskId: input.taskId,
    taskEpochDigest: input.taskEpochDigest,
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    rootIdentity: input.rootIdentity,
    treeDigest: input.treeDigest,
    baselineDigest: input.baselineDigest,
    declaredPathDigest,
    testPaths: classified.testPaths,
    specificationPaths: classified.specificationPaths,
  });
  const requestDigestOfThisMaterial = digestTaskWorktreeValue(material);
  const request: TaskWorktreeProtectedPathAuthorizationRequest = Object.freeze({
    ...material,
    requestDigestOfThisMaterial,
  });
  let raw: unknown;
  try {
    raw = await policy.authorize(request);
  } catch {
    return;
  }
  const decision = parseDecision(raw, requestDigestOfThisMaterial);
  if (decision === undefined) return;
  if (decision.mode === "implementation") {
    if (classified.specificationPaths.length > 0) return;
    if (!samePaths(decision.authorizedTestPaths, classified.testPaths)) return;
  } else if (
    classified.testPaths.length > 0 ||
    classified.specificationPaths.length !== input.changes.length ||
    decision.authorizedTestPaths.length > 0
  )
    return;
  return Object.freeze({
    mode: decision.mode,
    testPaths: classified.testPaths,
    specificationPaths: classified.specificationPaths,
    authorizationDigest: decision.authorizationDigest,
    baselineManifest,
    candidateManifest: baselineManifest,
    policyDigest: digestTaskWorktreeValue({
      authorityId,
      policyId: policy.policyId,
      testRoots: policy.testRoots,
      specificationRoots: policy.specificationRoots,
      requestDigestOfThisMaterial,
      authorizationDigest: decision.authorizationDigest,
      mode: decision.mode,
    }),
  });
}

export async function captureAuthorizedCandidateManifest(
  root: string,
  policy: TaskWorktreeConfig["protectedPaths"],
  state: ProtectedCandidateState,
): Promise<ProtectedCandidateState | undefined> {
  const candidateManifest = await captureProtectedManifest(root, policy);
  if (candidateManifest === undefined) return;
  return Object.freeze({ ...state, candidateManifest });
}

export function manifestsMatch(
  expected: ProtectedManifest,
  actual: ProtectedManifest,
): boolean {
  return expected.digest === actual.digest;
}

function classifyChanges(
  input: TaskWorktreePrepareInput,
  policy: TaskWorktreeConfig["protectedPaths"],
):
  | Readonly<{
      testPaths: readonly string[];
      specificationPaths: readonly string[];
    }>
  | undefined {
  const testPaths: string[] = [];
  const specificationPaths: string[] = [];
  for (const change of input.changes) {
    const test = classifyPath(change.path, policy.testRoots);
    const specification = classifyPath(change.path, policy.specificationRoots);
    if (test === "alias" || specification === "alias") return;
    if (test === "match") testPaths.push(change.path);
    if (specification === "match") specificationPaths.push(change.path);
  }
  return Object.freeze({
    testPaths: Object.freeze(testPaths),
    specificationPaths: Object.freeze(specificationPaths),
  });
}

function classifyPath(
  path: string,
  roots: readonly string[],
): "alias" | "match" | "outside" {
  const canonicalPath = path.toLowerCase();
  for (const root of roots) {
    const exact = path === root || path.startsWith(`${root}/`);
    const canonicalRoot = root.toLowerCase();
    const canonical =
      canonicalPath === canonicalRoot ||
      canonicalPath.startsWith(`${canonicalRoot}/`);
    if (canonical && !exact) return "alias";
    if (exact) return "match";
  }
  return "outside";
}

function parseDecision(
  input: unknown,
  requestDigest: ReturnType<typeof digestTaskWorktreeValue>,
):
  | Readonly<{
      mode: "design" | "implementation";
      authorizedTestPaths: readonly string[];
      authorizationDigest: ReturnType<typeof digestTaskWorktreeValue>;
    }>
  | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    !Object.isFrozen(input) ||
    Reflect.ownKeys(input).length !== 5 ||
    data(input, "status") !== "authorized" ||
    data(input, "requestDigest") !== requestDigest
  )
    return;
  const mode = data(input, "mode");
  const authorizationDigest = data(input, "authorizationDigest");
  const rawPaths = data(input, "authorizedTestPaths");
  if (
    (mode !== "implementation" && mode !== "design") ||
    !isTaskWorktreeDigest(authorizationDigest) ||
    !Array.isArray(rawPaths) ||
    !Object.isFrozen(rawPaths)
  )
    return;
  const paths: string[] = [];
  for (const path of rawPaths) {
    if (typeof path !== "string" || paths.includes(path)) return;
    paths.push(path);
  }
  return Object.freeze({
    mode,
    authorizedTestPaths: Object.freeze(paths),
    authorizationDigest,
  });
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function data(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}
