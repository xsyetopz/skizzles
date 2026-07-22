import { type Digest, digestValue } from "../../digest.ts";
import type {
  SchedulerLedgerEntry,
  SchedulerReceipt,
  SchedulerRunRequest,
} from "./contract.ts";

interface ReceiptState {
  readonly owner: object;
  readonly requestDigest: Digest;
}

const receipts = new WeakMap<object, ReceiptState>();

export function issueSchedulerReceipt(
  input: Readonly<{
    owner: object;
    request: SchedulerRunRequest;
    requestDigest: Digest;
    authorityId: string;
    maximumParallelism: number;
    entries: readonly SchedulerLedgerEntry[];
  }>,
): SchedulerReceipt {
  const {
    owner,
    request,
    requestDigest,
    authorityId,
    maximumParallelism,
    entries,
  } = input;
  const orderedEntries = Object.freeze(
    [...entries].sort((left, right) => compareText(left.taskId, right.taskId)),
  );
  const material = Object.freeze({
    executionId: request.executionId,
    requestDigest,
    authorityId,
    maximumParallelism,
    entries: orderedEntries,
    completedTaskIds: idsFor(orderedEntries, "completed"),
    failedTaskIds: idsFor(orderedEntries, "failed"),
    cancelledTaskIds: idsFor(orderedEntries, "cancelled"),
    blockedTaskIds: idsFor(orderedEntries, "blocked"),
  });
  const receipt: SchedulerReceipt = Object.freeze({
    ...material,
    receiptDigest: digestValue(material),
  });
  receipts.set(receipt, Object.freeze({ owner, requestDigest }));
  return receipt;
}

export function verifySchedulerReceipt(
  owner: object,
  requestDigest: Digest,
  value: unknown,
): value is SchedulerReceipt {
  if (typeof value !== "object" || value === null) return false;
  const state = receipts.get(value);
  if (
    state === undefined ||
    state.owner !== owner ||
    state.requestDigest !== requestDigest
  ) {
    return false;
  }
  const receipt = value as SchedulerReceipt;
  const material = {
    executionId: receipt.executionId,
    requestDigest: receipt.requestDigest,
    authorityId: receipt.authorityId,
    maximumParallelism: receipt.maximumParallelism,
    entries: receipt.entries,
    completedTaskIds: receipt.completedTaskIds,
    failedTaskIds: receipt.failedTaskIds,
    cancelledTaskIds: receipt.cancelledTaskIds,
    blockedTaskIds: receipt.blockedTaskIds,
  };
  return (
    Object.isFrozen(receipt) &&
    receipt.requestDigest === requestDigest &&
    receipt.receiptDigest === digestValue(material)
  );
}

export function ledgerEntry(
  input: Omit<SchedulerLedgerEntry, "receiptDigest">,
): SchedulerLedgerEntry {
  const material = Object.freeze({ ...input });
  return Object.freeze({ ...material, receiptDigest: digestValue(material) });
}

function idsFor(
  entries: readonly SchedulerLedgerEntry[],
  outcome: SchedulerLedgerEntry["outcome"],
): readonly string[] {
  return Object.freeze(
    entries
      .filter((entry) => entry.outcome === outcome)
      .map(({ taskId }) => taskId),
  );
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
