import { createTaskWorktreeCommitAuthority } from "../commit/index.ts";
import type { TaskWorktree, TaskWorktreeCreationResult } from "../contract.ts";
import {
  createDependencyResolutionService,
  createDependencyResolverAuthority,
} from "../dependency/resolution.ts";
import { createTaskWorktreeDiffAuthority } from "../diff/index.ts";
import { createGitCommandAuthority } from "../git/command.ts";
import {
  createPortableSandboxBroker,
  createSandboxCapabilityAuthority,
} from "../sandbox/capabilities.ts";
import {
  executeVerification,
  verifyVerificationReceipt,
} from "../verification/execution.ts";
import { close } from "./completion/close.ts";
import { parseConfig } from "./configuration/config.ts";
import {
  authorizeSession,
  commitSession,
  revalidateSession,
  runSession,
} from "./operations.ts";
import { prepare } from "./preparation/prepare.ts";
import { retryCleanup } from "./recovery/pending.ts";
import { isRegisteredTaskWorktree, registerAuthority } from "./state.ts";

export function createTaskWorktree(input: unknown): TaskWorktreeCreationResult {
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(input);
  } catch {
    config = undefined;
  }
  const git = createGitCommandAuthority();
  if (config === undefined || git === undefined)
    return Object.freeze({ status: "rejected", code: "INVALID_CONFIG" });
  const diff = createTaskWorktreeDiffAuthority(config.diffCeilings);
  const commit = createTaskWorktreeCommitAuthority(config.commitPolicy);
  const sandboxAuthority = createSandboxCapabilityAuthority(config.sandbox);
  const dependencyAuthority = createDependencyResolverAuthority(
    config.dependencyResolver,
  );
  if (
    diff.status !== "created" ||
    commit.status !== "created" ||
    sandboxAuthority.status !== "created" ||
    dependencyAuthority.status !== "created"
  )
    return Object.freeze({ status: "rejected", code: "INVALID_CONFIG" });
  const sandbox = createPortableSandboxBroker(
    Object.freeze({ authority: sandboxAuthority.authority }),
  );
  const dependencies = createDependencyResolutionService(
    Object.freeze({ authority: dependencyAuthority.authority }),
  );
  if (sandbox.status !== "created" || dependencies.status !== "created")
    return Object.freeze({ status: "rejected", code: "INVALID_CONFIG" });
  const owner = Object.freeze({});
  const taskWorktree: TaskWorktree = Object.freeze({
    prepare: async (prepareInput: unknown) =>
      await prepare(owner, prepareInput),
    retryCleanup: async (cleanupInput: unknown) =>
      await retryCleanup(owner, cleanupInput),
    run: async (runInput: unknown) => await runSession(owner, runInput),
    executeVerification: async (verificationInput: unknown) =>
      await executeVerification(owner, verificationInput),
    verifyVerificationReceipt: async (verificationInput: unknown) =>
      await verifyVerificationReceipt(owner, verificationInput),
    revalidate: async (revalidationInput: unknown) =>
      await revalidateSession(owner, revalidationInput),
    authorize: async (authorizationInput: unknown) =>
      await authorizeSession(owner, authorizationInput),
    commit: async (commitInput: unknown) =>
      await commitSession(owner, commitInput),
    close: async (closeInput: unknown) => await close(owner, closeInput),
  });
  registerAuthority(taskWorktree, {
    owner,
    git,
    config,
    active: new Map(),
    used: new Set(),
    diffAuthority: diff.authority,
    commitAuthority: commit.authority,
    sandbox: sandbox.broker,
    dependencies: dependencies.service,
  });
  return Object.freeze({ status: "created", taskWorktree });
}

export function isTaskWorktree(input: unknown): input is TaskWorktree {
  return isRegisteredTaskWorktree(input);
}
