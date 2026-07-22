import type { TaskWorktreeDigest } from "../digest.ts";

export interface TaskWorktreeProtectedPathPolicy {
  readonly policyId: string;
  readonly testRoots: readonly string[];
  readonly specificationRoots: readonly string[];
  readonly authorize: (
    request: TaskWorktreeProtectedPathAuthorizationRequest,
  ) => unknown | Promise<unknown>;
}

export interface TaskWorktreeProtectedPathAuthorizationRequest {
  readonly authorityId: string;
  readonly taskId: string;
  readonly taskEpochDigest: TaskWorktreeDigest;
  readonly requestDigest: TaskWorktreeDigest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: TaskWorktreeDigest;
  readonly baselineDigest: TaskWorktreeDigest;
  readonly declaredPathDigest: TaskWorktreeDigest;
  readonly testPaths: readonly string[];
  readonly specificationPaths: readonly string[];
  readonly requestDigestOfThisMaterial: TaskWorktreeDigest;
}

export type TaskWorktreeProtectedPathMode = "design" | "implementation";
