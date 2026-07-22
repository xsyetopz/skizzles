import type {
  TaskWorktreeReceipt,
  TaskWorktreeReceiptSummary,
} from "../../contract.ts";
import { digestTaskWorktreeValue } from "../../digest.ts";

const receipts = new WeakMap<
  object,
  Readonly<{
    owner: object;
    kind: "close" | "commit" | "prepare" | "revalidate" | "run";
  }>
>();

export function isTaskWorktreeReceipt(
  input: unknown,
): input is TaskWorktreeReceipt {
  return typeof input === "object" && input !== null && receipts.has(input);
}

export function createLifecycleReceipt(
  owner: object,
  evidenceDigest: ReturnType<typeof digestTaskWorktreeValue>,
  kind: "close" | "commit" | "prepare" | "revalidate" | "run",
  summary: TaskWorktreeReceiptSummary,
): TaskWorktreeReceipt {
  const receiptDigest = digestTaskWorktreeValue({
    kind,
    evidenceDigest,
    summary,
  });
  const receipt: TaskWorktreeReceipt = Object.freeze({
    schema: "skizzles.task-worktree/receipt" as const,
    ...summary,
    receiptDigest,
  });
  receipts.set(receipt, Object.freeze({ owner, kind }));
  return receipt;
}
