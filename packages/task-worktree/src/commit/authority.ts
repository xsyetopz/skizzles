import {
  isTaskWorktreeDiffReceipt,
  isTaskWorktreeSliceForReceipt,
} from "../diff/runtime.ts";
import type { TaskWorktreeDigest } from "../digest.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import type {
  ApprovedAtomicTaskSliceCommit,
  AtomicTaskSliceCommitPlan,
  AtomicTaskSliceCommitReceipt,
  CommitAuthorizationResult,
  CommitPlanResult,
  CommitSynthesisPolicy,
  TaskWorktreeCommitAuthority,
  TaskWorktreeCommitAuthorityCreationResult,
} from "./contract.ts";
import {
  digestDiffSliceInput,
  hasDataProperty,
  isDigest,
  isPlainFrozenRecord,
  parseDiffSliceInput,
  parsePolicy,
} from "./input.ts";
import { changesForSlice, synthesizeMessage } from "./message.ts";

const authorities = new WeakSet<object>();
const receipts = new WeakSet<object>();
const receiptBindings = new WeakMap<
  object,
  Readonly<{ owner: object; inputDigest: TaskWorktreeDigest }>
>();

export function createTaskWorktreeCommitAuthority(
  input: unknown,
): TaskWorktreeCommitAuthorityCreationResult {
  const policy = parsePolicy(input);
  if (policy === undefined) {
    return Object.freeze({ status: "rejected", code: "INVALID_COMMIT_POLICY" });
  }
  const owner = Object.freeze({});
  const authority: TaskWorktreeCommitAuthority = Object.freeze({
    prepare: (raw: unknown) => prepare(owner, policy, raw),
    authorize: (raw: unknown) => authorize(owner, raw),
    verify: (raw: unknown) => verify(owner, raw),
  });
  authorities.add(authority);
  return Object.freeze({ status: "created", authority });
}

export function isTaskWorktreeCommitAuthority(
  input: unknown,
): input is TaskWorktreeCommitAuthority {
  return typeof input === "object" && input !== null && authorities.has(input);
}

export function isAtomicTaskSliceCommitReceipt(
  input: unknown,
): input is AtomicTaskSliceCommitReceipt {
  return typeof input === "object" && input !== null && receipts.has(input);
}

function prepare(
  owner: object,
  policy: CommitSynthesisPolicy,
  raw: unknown,
): CommitPlanResult {
  const parsed = parseDiffSliceInput(raw);
  if (parsed === undefined || !isTaskWorktreeDiffReceipt(parsed.receipt)) {
    return Object.freeze({ status: "rejected", code: "INVALID_DIFF_RECEIPT" });
  }
  if (!isTaskWorktreeSliceForReceipt(parsed.slice, parsed.receipt)) {
    return Object.freeze({ status: "rejected", code: "INVALID_TASK_SLICE" });
  }
  const input = Object.freeze({ receipt: parsed.receipt, slice: parsed.slice });
  const changes = changesForSlice(input.receipt.changes, input.slice.paths);
  if (changes === undefined)
    return Object.freeze({ status: "rejected", code: "INVALID_TASK_SLICE" });
  const message = synthesizeMessage(
    changes,
    policy,
    input.receipt.receiptDigest,
    input.slice.sliceDigest,
  );
  if (message.status === "ambiguous") {
    return Object.freeze({ status: "rejected", code: "SCOPE_AMBIGUOUS" });
  }
  if (message.status === "invalid") {
    return Object.freeze({ status: "rejected", code: "MESSAGE_INVALID" });
  }
  const planMaterial = Object.freeze({
    mode: "atomic-task-slice" as const,
    receiptDigest: input.receipt.receiptDigest,
    sliceDigest: input.slice.sliceDigest,
    message: message.message,
  });
  const plan: AtomicTaskSliceCommitPlan = Object.freeze({
    ...planMaterial,
    planDigest: digestTaskWorktreeValue(planMaterial),
  });
  const receiptMaterial = Object.freeze({ plan });
  const receipt: AtomicTaskSliceCommitReceipt = Object.freeze({
    ...receiptMaterial,
    receiptDigest: digestTaskWorktreeValue(receiptMaterial),
  });
  receipts.add(receipt);
  receiptBindings.set(
    receipt,
    Object.freeze({ owner, inputDigest: digestDiffSliceInput(input) }),
  );
  return Object.freeze({ status: "prepared", receipt });
}

function authorize(owner: object, raw: unknown): CommitAuthorizationResult {
  if (
    !(
      isPlainFrozenRecord(raw, ["approvalDigest", "receipt"]) &&
      hasDataProperty(raw, "receipt") &&
      hasDataProperty(raw, "approvalDigest")
    )
  ) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_COMMIT_RECEIPT",
    });
  }
  const receipt = raw["receipt"];
  const approvalDigest = raw["approvalDigest"];
  if (!isAtomicTaskSliceCommitReceipt(receipt)) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_COMMIT_RECEIPT",
    });
  }
  const binding = receiptBindings.get(receipt);
  if (binding === undefined || binding.owner !== owner) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_COMMIT_RECEIPT",
    });
  }
  if (!isDigest(approvalDigest)) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_APPROVAL_DIGEST",
    });
  }
  const approval: ApprovedAtomicTaskSliceCommit = Object.freeze({
    planDigest: receipt.plan.planDigest,
    approvalDigest,
    authorizationDigest: digestTaskWorktreeValue({
      planDigest: receipt.plan.planDigest,
      approvalDigest,
      receiptDigest: receipt.receiptDigest,
    }),
  });
  return Object.freeze({ status: "authorized", approval });
}

function verify(owner: object, raw: unknown): boolean {
  try {
    if (
      !(
        isPlainFrozenRecord(raw, ["input", "receipt"]) &&
        hasDataProperty(raw, "input") &&
        hasDataProperty(raw, "receipt")
      )
    )
      return false;
    const parsed = parseDiffSliceInput(raw["input"]);
    const receipt = raw["receipt"];
    if (
      parsed === undefined ||
      !isTaskWorktreeDiffReceipt(parsed.receipt) ||
      !isTaskWorktreeSliceForReceipt(parsed.slice, parsed.receipt) ||
      !isAtomicTaskSliceCommitReceipt(receipt)
    )
      return false;
    const input = Object.freeze({
      receipt: parsed.receipt,
      slice: parsed.slice,
    });
    const binding = receiptBindings.get(receipt);
    if (
      binding === undefined ||
      binding.owner !== owner ||
      binding.inputDigest !== digestDiffSliceInput(input)
    )
      return false;
    const { receiptDigest, ...material } = receipt;
    return receiptDigest === digestTaskWorktreeValue(material);
  } catch {
    return false;
  }
}
