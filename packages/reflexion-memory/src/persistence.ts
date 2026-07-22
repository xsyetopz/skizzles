import { isReflexionDigest } from "./canonical.ts";
import type {
  ReflexionDigest,
  ReflexionFailureRecordInput,
  ReflexionMemoryPersistenceAuthority,
  ReflexionMemoryRecorder,
  ReflexionPersistenceReceipt,
} from "./contract.ts";
import { dataRecord } from "./object.ts";
import { createReflexionFailureRecord } from "./record.ts";

const receiptKeys = [
  "schema",
  "domain",
  "version",
  "disposition",
  "recordDigest",
  "persistenceRevisionDigest",
] as const;
const recorders = new WeakSet<object>();

export function createReflexionMemoryRecorder(
  persistence: ReflexionMemoryPersistenceAuthority,
): ReflexionMemoryRecorder {
  const recorded = new Set<ReflexionDigest>();
  const inFlight = new Set<ReflexionDigest>();
  const recorder: ReflexionMemoryRecorder = Object.freeze({
    async recordFailure(
      input: ReflexionFailureRecordInput,
    ): Promise<ReflexionPersistenceReceipt> {
      const record = createReflexionFailureRecord(input);
      if (
        recorded.has(record.recordDigest) ||
        inFlight.has(record.recordDigest)
      ) {
        throw new Error("reflexion failure record replay rejected");
      }
      inFlight.add(record.recordDigest);
      try {
        const receipt = parseReflexionPersistenceReceipt(
          await persistence.storeFailureRecordIfAbsent(record),
        );
        if (
          receipt === undefined ||
          receipt.recordDigest !== record.recordDigest
        ) {
          throw new Error(
            "persistence receipt does not bind the failure record",
          );
        }
        if (receipt.disposition !== "stored") {
          throw new Error("reflexion failure record replay rejected");
        }
        recorded.add(record.recordDigest);
        return receipt;
      } finally {
        inFlight.delete(record.recordDigest);
      }
    },
  });
  recorders.add(recorder);
  return recorder;
}

export function isReflexionMemoryRecorder(
  value: unknown,
): value is ReflexionMemoryRecorder {
  return typeof value === "object" && value !== null && recorders.has(value);
}

export function createReflexionPersistenceReceipt(input: {
  readonly disposition: "stored" | "duplicate";
  readonly recordDigest: ReflexionDigest;
  readonly persistenceRevisionDigest: ReflexionDigest;
}): ReflexionPersistenceReceipt {
  if (
    !(
      isReflexionDigest(input.recordDigest) &&
      isReflexionDigest(input.persistenceRevisionDigest)
    )
  ) {
    throw new TypeError("persistence receipts require SHA-256 digests");
  }
  return Object.freeze({
    schema: "skizzles.reflexion-memory/persistence-receipt" as const,
    domain: "reflexion-failure-memory" as const,
    version: 1 as const,
    disposition: input.disposition,
    recordDigest: input.recordDigest,
    persistenceRevisionDigest: input.persistenceRevisionDigest,
  });
}

export function parseReflexionPersistenceReceipt(
  value: unknown,
): ReflexionPersistenceReceipt | undefined {
  const receipt = dataRecord(value, receiptKeys, true);
  if (
    receipt === undefined ||
    receipt.schema !== "skizzles.reflexion-memory/persistence-receipt" ||
    receipt.domain !== "reflexion-failure-memory" ||
    receipt.version !== 1 ||
    (receipt.disposition !== "stored" && receipt.disposition !== "duplicate") ||
    !isReflexionDigest(receipt.recordDigest) ||
    !isReflexionDigest(receipt.persistenceRevisionDigest)
  ) {
    return;
  }
  return Object.freeze({
    schema: receipt.schema,
    domain: receipt.domain,
    version: receipt.version,
    disposition: receipt.disposition,
    recordDigest: receipt.recordDigest,
    persistenceRevisionDigest: receipt.persistenceRevisionDigest,
  });
}
