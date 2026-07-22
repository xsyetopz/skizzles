import type { TaskWorktreeDigest } from "../digest.ts";
import { makeReceipt, makeSplitPlan } from "./assessment.ts";
import type {
  DiffAssessmentResult,
  DiffCeilings,
  TaskWorktreeDiffAuthority,
  TaskWorktreeDiffAuthorityCreationResult,
  TaskWorktreeDiffReceipt,
  TaskWorktreeSlice,
  TaskWorktreeSplitPlan,
} from "./contract.ts";
import {
  digestInput,
  hasDataProperty,
  isPlainFrozenRecord,
  parseCeilings,
  parseExactInput,
} from "./input.ts";

const authorities = new WeakSet<object>();
const receipts = new WeakSet<object>();
const plans = new WeakSet<object>();
const sliceBindings = new WeakMap<object, TaskWorktreeDiffReceipt>();
const receiptBindings = new WeakMap<
  object,
  Readonly<{ owner: object; inputDigest: TaskWorktreeDigest }>
>();

export function createTaskWorktreeDiffAuthority(
  input: unknown,
): TaskWorktreeDiffAuthorityCreationResult {
  const ceilings = parseCeilings(input);
  if (ceilings === undefined) {
    return Object.freeze({ status: "rejected", code: "INVALID_DIFF_POLICY" });
  }
  const owner = Object.freeze({});
  const authority: TaskWorktreeDiffAuthority = Object.freeze({
    inspect: (raw: unknown) => inspect(owner, ceilings, raw),
    verify: (raw: unknown) => verify(owner, ceilings, raw),
  });
  authorities.add(authority);
  return Object.freeze({ status: "created", authority });
}

export function isTaskWorktreeDiffAuthority(
  input: unknown,
): input is TaskWorktreeDiffAuthority {
  return typeof input === "object" && input !== null && authorities.has(input);
}

export function isTaskWorktreeDiffReceipt(
  input: unknown,
): input is TaskWorktreeDiffReceipt {
  return typeof input === "object" && input !== null && receipts.has(input);
}

export function isTaskWorktreeSplitPlan(
  input: unknown,
): input is TaskWorktreeSplitPlan {
  return typeof input === "object" && input !== null && plans.has(input);
}

export function isTaskWorktreeSliceForReceipt(
  input: unknown,
  receipt: TaskWorktreeDiffReceipt,
): input is TaskWorktreeSlice {
  return (
    typeof input === "object" &&
    input !== null &&
    sliceBindings.get(input) === receipt
  );
}

function inspect(
  owner: object,
  ceilings: DiffCeilings,
  raw: unknown,
): DiffAssessmentResult {
  const input = parseExactInput(raw);
  if (input === undefined) {
    return Object.freeze({ status: "rejected", code: "INVALID_EXACT_INPUT" });
  }
  const receipt = makeReceipt(input, ceilings);
  if (receipt === undefined) {
    return Object.freeze({ status: "rejected", code: "UNSPLITTABLE_CHANGE" });
  }
  const plan = makeSplitPlan(receipt, ceilings);
  if (plan === undefined) {
    return Object.freeze({ status: "rejected", code: "UNSPLITTABLE_CHANGE" });
  }
  receipts.add(receipt);
  receiptBindings.set(
    receipt,
    Object.freeze({ owner, inputDigest: digestInput(input) }),
  );
  plans.add(plan);
  for (const slice of plan.slices) sliceBindings.set(slice, receipt);
  if (plan.slices.length === 1) {
    return Object.freeze({ status: "accepted", receipt, plan });
  }
  return Object.freeze({ status: "split-required", receipt, plan });
}

function verify(owner: object, ceilings: DiffCeilings, raw: unknown): boolean {
  try {
    if (
      !(
        isPlainFrozenRecord(raw, ["input", "receipt"]) &&
        hasDataProperty(raw, "input") &&
        hasDataProperty(raw, "receipt")
      )
    ) {
      return false;
    }
    const input = parseExactInput(raw["input"]);
    const receipt = raw["receipt"];
    if (input === undefined || !isTaskWorktreeDiffReceipt(receipt)) {
      return false;
    }
    const binding = receiptBindings.get(receipt);
    if (binding === undefined || binding.owner !== owner) return false;
    if (binding.inputDigest !== digestInput(input)) return false;
    const regenerated = makeReceipt(input, ceilings);
    return (
      regenerated !== undefined &&
      regenerated.receiptDigest === receipt.receiptDigest
    );
  } catch {
    return false;
  }
}
