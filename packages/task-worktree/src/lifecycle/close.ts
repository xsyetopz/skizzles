import type {
  TaskWorktreeCloseResult,
  TaskWorktreeFailureCode,
} from "../contract.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import { branchHead, listWorktrees, pathExists } from "../git/repository.ts";
import { removeWritableRoot } from "./allocation.ts";
import { parseActionInput } from "./configuration/actions.ts";
import { revalidateSession } from "./operations.ts";
import { createLifecycleReceipt } from "./receipt.ts";
import {
  inspectAllocation,
  stateForOwner,
  taskKeyFor,
  taskWorktreeSessionBindings,
} from "./state.ts";

export async function close(
  owner: object,
  raw: unknown,
): Promise<TaskWorktreeCloseResult> {
  const state = stateForOwner(owner);
  if (state === undefined) return rejected("INVALID_CONFIG");
  let input: ReturnType<typeof parseActionInput>;
  try {
    input = parseActionInput(raw);
  } catch {
    input = undefined;
  }
  if (input === undefined) return rejected("INVALID_INPUT");
  const bindings = taskWorktreeSessionBindings(input.session);
  if (
    bindings === undefined ||
    bindings.owner !== owner ||
    state.active.get(taskKeyFor(bindings.input)) !== input.session
  ) {
    return rejected("SESSION_MISMATCH");
  }
  if (bindings.closed) return rejected("LIFECYCLE_CLOSED");
  let candidateValidated = false;
  if (
    bindings.candidate.committedHead === null &&
    !bindings.cleanup.worktreeRemoved
  ) {
    const allocation = await inspectAllocation(bindings);
    if (allocation === undefined || !allocation.registered)
      return rejected("REPOSITORY_MISMATCH");
    if (!allocation.clean) {
      const validation = await revalidateSession(
        owner,
        Object.freeze({ version: 1 as const, session: input.session }),
      );
      if (validation.status !== "valid") return rejected("DIRTY_WORKTREE");
      candidateValidated = true;
    }
  }
  if (!bindings.cleanup.baselineViewRemoved) {
    const baselineViewRoot = bindings.verification.baselineViewRoot;
    if (baselineViewRoot !== null) {
      const entries = await listWorktrees(
        bindings.git,
        bindings.repository.root,
      );
      if (
        entries === undefined ||
        !entries.some(
          (entry) =>
            entry.root === baselineViewRoot &&
            entry.head === bindings.repository.head &&
            entry.branch === null,
        )
      )
        return rejected("CLEANUP_INCOMPLETE");
      const removed = await bindings.git.run(bindings.repository.root, [
        "worktree",
        "remove",
        "--force",
        "--",
        baselineViewRoot,
      ]);
      if (removed === undefined) return rejected("CLEANUP_INCOMPLETE");
      const remaining = await listWorktrees(
        bindings.git,
        bindings.repository.root,
      );
      if (
        remaining === undefined ||
        remaining.some((entry) => entry.root === baselineViewRoot) ||
        (await pathExists(baselineViewRoot))
      )
        return rejected("CLEANUP_INCOMPLETE");
    }
    bindings.cleanup.baselineViewRemoved = true;
  }
  if (!bindings.cleanup.worktreeRemoved) {
    const allocation = await inspectAllocation(bindings);
    if (allocation === undefined) return rejected("COMMAND_FAILED");
    if (!allocation.registered) return rejected("REPOSITORY_MISMATCH");
    if (!allocation.clean) {
      if (bindings.candidate.committedHead !== null)
        return rejected("DIRTY_WORKTREE");
      if (!candidateValidated) {
        const validation = await revalidateSession(
          owner,
          Object.freeze({ version: 1 as const, session: input.session }),
        );
        if (validation.status !== "valid") return rejected("DIRTY_WORKTREE");
      }
    }
    const removed = await bindings.git.run(bindings.repository.root, [
      "worktree",
      "remove",
      ...(bindings.candidate.committedHead === null ? ["--force"] : []),
      "--",
      bindings.root,
    ]);
    if (removed === undefined) return rejected("CLEANUP_INCOMPLETE");
    const remaining = await listWorktrees(
      bindings.git,
      bindings.repository.root,
    );
    if (
      remaining === undefined ||
      remaining.some((entry) => entry.root === bindings.root) ||
      (await pathExists(bindings.root))
    ) {
      return rejected("CLEANUP_INCOMPLETE");
    }
    bindings.cleanup.finalHead = allocation.head;
    bindings.cleanup.worktreeRemoved = true;
  }
  if (
    !bindings.cleanup.writableRemoved &&
    !(await removeWritableRoot(
      state.config.worktreeParent,
      bindings.writableRoot,
    ))
  ) {
    return rejected("CLEANUP_INCOMPLETE");
  }
  bindings.cleanup.writableRemoved = true;
  if (!bindings.cleanup.branchRemoved) {
    const head = await branchHead(
      bindings.git,
      bindings.repository.root,
      bindings.branch,
    );
    if (head !== null && head !== bindings.cleanup.finalHead) {
      return rejected("CLEANUP_INCOMPLETE");
    }
    if (head !== null) {
      const remaining = await listWorktrees(
        bindings.git,
        bindings.repository.root,
      );
      if (remaining?.some((entry) => entry.branch === bindings.branch)) {
        return rejected("CLEANUP_INCOMPLETE");
      }
      const deleted = await bindings.git.run(bindings.repository.root, [
        "branch",
        "-D",
        "--",
        bindings.branch,
      ]);
      if (deleted === undefined) return rejected("CLEANUP_INCOMPLETE");
    }
    bindings.cleanup.branchRemoved = true;
  }
  bindings.closed = true;
  state.active.delete(taskKeyFor(bindings.input));
  const digest = digestTaskWorktreeValue({
    kind: "close",
    prepareDigest: bindings.prepareDigest,
    finalHead: bindings.cleanup.finalHead,
    branch: bindings.branch,
    baselineViewRemoved: bindings.cleanup.baselineViewRemoved,
    verificationReceipts: bindings.verification.receipts.map(
      ({ receiptDigest }) => receiptDigest,
    ),
  });
  return Object.freeze({
    status: "closed",
    receipt: createLifecycleReceipt(owner, digest, "close", bindings.summary),
  });
}

function rejected(
  code: TaskWorktreeFailureCode,
): Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }> {
  return Object.freeze({ status: "rejected", code });
}
