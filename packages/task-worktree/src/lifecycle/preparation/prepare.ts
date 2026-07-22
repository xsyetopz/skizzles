import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  TaskWorktreeFailureCode,
  TaskWorktreePrepareResult,
  TaskWorktreePrepareTerminalResult,
  TaskWorktreeSession,
} from "../../contract.ts";
import { digestTaskWorktreeValue } from "../../digest.ts";
import {
  branchHead,
  captureRepository,
  exactChild,
  listWorktrees,
  pathExists,
} from "../../git/repository.ts";
import { prepareCandidate } from "../candidate/prepare.ts";
import { createLifecycleReceipt } from "../completion/receipt.ts";
import { createReceiptSummary } from "../completion/summary.ts";
import { parsePrepareInput } from "../configuration/prepare.ts";
import {
  type AllocationClaim,
  acquireAllocationClaim,
  cleanupFailedAllocation,
  markAllocationCreated,
  markAllocationUncertain,
  releaseAllocationClaim,
} from "../recovery/claim.ts";
import { createPendingCleanup } from "../recovery/pending.ts";
import {
  bindSession,
  stateForOwner,
  type TaskWorktreeSessionBindings,
} from "../state.ts";
import {
  allocationFor,
  validateAllocationParent,
  verifyAllocation,
} from "./allocation.ts";

export async function prepare(
  owner: object,
  raw: unknown,
): Promise<TaskWorktreePrepareResult> {
  const state = stateForOwner(owner);
  if (state === undefined) return rejected("INVALID_CONFIG");
  let input: ReturnType<typeof parsePrepareInput>;
  try {
    input = parsePrepareInput(raw);
  } catch {
    input = undefined;
  }
  if (input === undefined) return rejected("INVALID_INPUT");
  const taskKey = `${input.repositoryId}\0${input.rootIdentity}\0${input.taskId}\0${input.taskEpochDigest}`;
  if (state.active.has(taskKey) || state.used.has(taskKey))
    return rejected("ALREADY_PREPARED");
  if (
    input.repositoryId !== state.config.repositoryId ||
    input.rootIdentity !== state.config.rootIdentity
  ) {
    return rejected("REPOSITORY_MISMATCH");
  }
  const repository = await captureRepository(
    state.git,
    state.config.repositoryRoot,
  );
  if (repository === undefined) return rejected("REPOSITORY_MISMATCH");
  const parent = await validateAllocationParent(
    state.config.worktreeParent,
    repository.root,
  );
  if (parent === undefined) return rejected("SYMLINK_REJECTED");
  const allocation = allocationFor(input);
  const worktreeRoot = join(parent, allocation.leaf);
  const writableRoot = join(parent, `${allocation.leaf}-writable`);
  if (!exactChild(parent, worktreeRoot) || !exactChild(parent, writableRoot))
    return rejected("INVALID_INPUT");
  if ((await pathExists(worktreeRoot)) || (await pathExists(writableRoot)))
    return rejected("WORKTREE_COLLISION");
  const existingBranch = await branchHead(
    state.git,
    repository.root,
    allocation.branch,
  );
  if (existingBranch === undefined) return rejected("COMMAND_FAILED");
  if (existingBranch !== null) return rejected("BRANCH_COLLISION");
  const registered = await listWorktrees(state.git, repository.root);
  if (registered === undefined) return rejected("COMMAND_FAILED");
  if (registered.some((entry) => entry.root === worktreeRoot)) {
    return rejected("WORKTREE_COLLISION");
  }
  const claim = await acquireAllocationClaim(
    parent,
    worktreeRoot,
    writableRoot,
    allocation.branch,
    state.git,
    repository,
  );
  if (claim === undefined) return rejected("WORKTREE_COLLISION");
  if ((await pathExists(worktreeRoot)) || (await pathExists(writableRoot))) {
    return await finishFailedPrepare(
      owner,
      claim,
      rejected("WORKTREE_COLLISION"),
    );
  }
  const claimedBranch = await branchHead(
    state.git,
    repository.root,
    allocation.branch,
  );
  if (claimedBranch === undefined) {
    return await finishFailedPrepare(owner, claim, rejected("COMMAND_FAILED"));
  }
  if (claimedBranch !== null) {
    return await finishFailedPrepare(
      owner,
      claim,
      rejected("BRANCH_COLLISION"),
    );
  }
  const claimedWorktrees = await listWorktrees(state.git, repository.root);
  if (claimedWorktrees === undefined) {
    return await finishFailedPrepare(owner, claim, rejected("COMMAND_FAILED"));
  }
  if (claimedWorktrees.some((entry) => entry.root === worktreeRoot)) {
    return await finishFailedPrepare(
      owner,
      claim,
      rejected("WORKTREE_COLLISION"),
    );
  }
  const created = await state.git.run(repository.root, [
    "worktree",
    "add",
    "-b",
    allocation.branch,
    "--",
    worktreeRoot,
    repository.head,
  ]);
  if (created === undefined) {
    const outcome = rejected("COMMAND_FAILED");
    if (!markAllocationUncertain(claim)) {
      return createPendingCleanup(owner, claim, outcome);
    }
    return await finishFailedPrepare(owner, claim, outcome);
  }
  if (!markAllocationCreated(claim)) {
    return await finishFailedPrepare(owner, claim, rejected("COMMAND_FAILED"));
  }
  const verified = await verifyAllocation(
    state.git,
    repository,
    worktreeRoot,
    allocation.branch,
    repository.head,
  );
  if (!verified) {
    return await finishFailedPrepare(owner, claim, rejected("COMMAND_FAILED"));
  }
  try {
    await mkdir(writableRoot, { mode: 0o700 });
    if (
      (await realpath(writableRoot)) !== writableRoot ||
      !(await lstat(writableRoot)).isDirectory()
    )
      throw new Error("invalid writable root");
  } catch {
    return await finishFailedPrepare(owner, claim, rejected("COMMAND_FAILED"));
  }
  const preparedCandidate = await prepareCandidate({
    root: worktreeRoot,
    authorityId: state.config.authorityId,
    declaration: input,
    protectedPaths: state.config.protectedPaths,
    verificationProfiles: state.config.verificationProfiles,
    diffAuthority: state.diffAuthority,
    commitAuthority: state.commitAuthority,
    sandbox: state.sandbox,
    sandboxWritePaths: state.config.sandboxWritePaths,
    dependencies: state.dependencies,
    dependencyRequests: state.config.dependencyRequests,
  });
  if (preparedCandidate.status !== "prepared") {
    if (preparedCandidate.status === "split-required") {
      return await finishFailedPrepare(
        owner,
        claim,
        Object.freeze({
          status: "split-required",
          plan: preparedCandidate.plan,
        }),
      );
    }
    if (preparedCandidate.status === "intervention-required") {
      return await finishFailedPrepare(
        owner,
        claim,
        Object.freeze({
          status: "intervention-required",
          diagnostics: preparedCandidate.diagnostics,
        }),
      );
    }
    return await finishFailedPrepare(
      owner,
      claim,
      rejected(preparedCandidate.code),
    );
  }
  const session: TaskWorktreeSession = Object.freeze({
    schema: "skizzles.task-worktree/session" as const,
  });
  const prepareDigest = digestTaskWorktreeValue({
    kind: "prepare",
    input,
    repository: {
      commonDirectory: repository.commonDirectory,
      head: repository.head,
      root: repository.root,
    },
    branch: allocation.branch,
    worktreeRoot,
  });
  const summary = createReceiptSummary(
    state.config.authorityId,
    input,
    repository,
    allocation.branch,
    preparedCandidate.candidate,
    state.config.sandboxWritePaths,
    state.config.commandProfiles,
  );
  const bindings: TaskWorktreeSessionBindings = {
    owner,
    session,
    git: state.git,
    repository,
    input,
    branch: allocation.branch,
    root: worktreeRoot,
    writableRoot,
    prepareDigest,
    candidate: preparedCandidate.candidate,
    diffAuthority: state.diffAuthority,
    commitAuthority: state.commitAuthority,
    commandProfiles: state.config.commandProfiles,
    verificationProfiles: state.config.verificationProfiles,
    protectedPaths: state.config.protectedPaths,
    sandbox: state.sandbox,
    sandboxWritePaths: state.config.sandboxWritePaths,
    approvalAuthority: state.config.approvalAuthority,
    summary,
    latestRun: null,
    verification: {
      baselineViewRoot: null,
      receipts: [],
    },
    cleanup: {
      worktreeRemoved: false,
      writableRemoved: false,
      baselineViewRemoved: false,
      branchRemoved: false,
      finalHead: null,
    },
    closed: false,
  };
  if (!(await releaseAllocationClaim(claim))) {
    return await finishFailedPrepare(
      owner,
      claim,
      rejected("CLEANUP_INCOMPLETE"),
    );
  }
  bindSession(session, bindings);
  state.active.set(taskKey, session);
  state.used.add(taskKey);
  const receipt = createLifecycleReceipt(
    owner,
    prepareDigest,
    "prepare",
    summary,
  );
  return Object.freeze({ status: "prepared", session, receipt });
}

async function finishFailedPrepare(
  owner: object,
  claim: AllocationClaim,
  outcome: TaskWorktreePrepareTerminalResult,
): Promise<TaskWorktreePrepareResult> {
  if (await cleanupFailedAllocation(claim)) return outcome;
  return createPendingCleanup(owner, claim, outcome);
}

function rejected(
  code: TaskWorktreeFailureCode,
): Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }> {
  return Object.freeze({ status: "rejected", code });
}
