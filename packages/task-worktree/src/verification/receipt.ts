import type { TaskWorktreeSession } from "../contract.ts";
import type { TaskWorktreeDigest } from "../digest.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import type { SandboxVerificationObjective } from "../sandbox/contract.ts";
import type {
  TaskWorktreeVerificationArtifactReceipt,
  TaskWorktreeVerificationProfile,
  TaskWorktreeVerificationReceipt,
} from "./contract.ts";

export interface VerificationReceiptState {
  readonly owner: object;
  readonly session: TaskWorktreeSession;
  readonly profile: TaskWorktreeVerificationProfile;
  readonly viewRoot: string;
  readonly artifactRoot: string;
  readonly artifact: TaskWorktreeVerificationArtifactReceipt;
  readonly objective: SandboxVerificationObjective;
  readonly objectiveDigest: TaskWorktreeDigest;
}

const receipts = new WeakMap<object, VerificationReceiptState>();

export function isTaskWorktreeVerificationReceipt(
  input: unknown,
): input is TaskWorktreeVerificationReceipt {
  return typeof input === "object" && input !== null && receipts.has(input);
}

export function verificationReceiptState(
  input: unknown,
): VerificationReceiptState | undefined {
  return typeof input === "object" && input !== null
    ? receipts.get(input)
    : undefined;
}

export function createVerificationReceipt(
  state: VerificationReceiptState,
  body: Omit<
    TaskWorktreeVerificationReceipt,
    "artifact" | "receiptDigest" | "schema"
  >,
): TaskWorktreeVerificationReceipt {
  const receiptBody = Object.freeze({
    schema: "skizzles.task-worktree/verification-receipt" as const,
    ...body,
    artifact: state.artifact,
  });
  const receipt = Object.freeze({
    ...receiptBody,
    receiptDigest: digestTaskWorktreeValue(receiptBody),
  });
  receipts.set(receipt, Object.freeze(state));
  return receipt;
}
