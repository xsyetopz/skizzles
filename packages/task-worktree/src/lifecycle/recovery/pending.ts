import { types } from "node:util";
import type {
  TaskWorktreeCleanupHandle,
  TaskWorktreeCleanupPendingResult,
  TaskWorktreeCleanupResult,
  TaskWorktreePrepareTerminalResult,
} from "../../contract.ts";
import { stateForOwner } from "../state.ts";
import { type AllocationClaim, cleanupFailedAllocation } from "./claim.ts";

interface PendingCleanupBinding {
  readonly owner: object;
  readonly claim: AllocationClaim;
  readonly handle: TaskWorktreeCleanupHandle;
  readonly outcome: TaskWorktreePrepareTerminalResult;
  cleaned: boolean;
}

const cleanupBindings = new WeakMap<object, PendingCleanupBinding>();

export function createPendingCleanup(
  owner: object,
  claim: AllocationClaim,
  outcome: TaskWorktreePrepareTerminalResult,
): TaskWorktreeCleanupPendingResult {
  const handle: TaskWorktreeCleanupHandle = Object.freeze({
    schema: "skizzles.task-worktree/cleanup-handle" as const,
  });
  cleanupBindings.set(handle, {
    owner,
    claim,
    handle,
    outcome,
    cleaned: false,
  });
  return pending(handle, outcome);
}

export async function retryCleanup(
  owner: object,
  raw: unknown,
): Promise<TaskWorktreeCleanupResult> {
  if (stateForOwner(owner) === undefined) {
    return Object.freeze({ status: "rejected", code: "INVALID_CONFIG" });
  }
  const handle = parseCleanupInput(raw);
  if (handle === undefined) {
    return Object.freeze({ status: "rejected", code: "INVALID_INPUT" });
  }
  const binding = cleanupBindings.get(handle);
  if (binding === undefined || binding.owner !== owner) {
    return Object.freeze({ status: "rejected", code: "SESSION_MISMATCH" });
  }
  if (!binding.cleaned) {
    binding.cleaned = await cleanupFailedAllocation(binding.claim);
  }
  if (binding.cleaned) {
    return Object.freeze({ status: "cleaned", outcome: binding.outcome });
  }
  return pending(binding.handle, binding.outcome);
}

function pending(
  handle: TaskWorktreeCleanupHandle,
  outcome: TaskWorktreePrepareTerminalResult,
): TaskWorktreeCleanupPendingResult {
  return Object.freeze({
    status: "cleanup-pending",
    code: "CLEANUP_INCOMPLETE",
    handle,
    outcome,
  });
}

function parseCleanupInput(
  input: unknown,
): TaskWorktreeCleanupHandle | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    !Object.isFrozen(input) ||
    Reflect.ownKeys(input).length !== 2
  ) {
    return;
  }
  const version = Object.getOwnPropertyDescriptor(input, "version");
  const handle = Object.getOwnPropertyDescriptor(input, "handle");
  if (
    version === undefined ||
    !("value" in version) ||
    version.value !== 1 ||
    handle === undefined ||
    !("value" in handle) ||
    typeof handle.value !== "object" ||
    handle.value === null
  ) {
    return;
  }
  return handle.value as TaskWorktreeCleanupHandle;
}
