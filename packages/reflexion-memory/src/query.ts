import {
  compareStrings,
  digestCanonical,
  isReflexionDigest,
  normalizeIdentifier,
} from "./canonical.ts";
import type {
  ReflexionDigest,
  ReflexionFailureRecord,
  ReflexionMemoryQuery,
  ReflexionMemoryRecordSource,
  ReflexionMemoryScope,
  ReflexionMemorySnapshot,
} from "./contract.ts";
import { dataRecord, strictFrozenArray } from "./object.ts";
import { parseReflexionFailureRecord } from "./record.ts";

const scopeKeys = ["currentTaskId", "currentRunId"] as const;
const snapshotKeys = [
  "schema",
  "domain",
  "version",
  "scope",
  "records",
  "snapshotDigest",
] as const;
const maximumRecordCount = 4096;
const queries = new WeakSet<object>();

function createReflexionMemoryQuery(
  source: ReflexionMemoryRecordSource,
): ReflexionMemoryQuery {
  const query: ReflexionMemoryQuery = Object.freeze({
    async snapshot(
      scope: ReflexionMemoryScope,
    ): Promise<ReflexionMemorySnapshot> {
      const canonicalScope = parseScope(scope, false);
      const loaded = strictFrozenArray(await source.readFailureRecords());
      if (loaded === undefined || loaded.length > maximumRecordCount) {
        throw new TypeError(
          "memory source must return a bounded immutable array",
        );
      }
      const records: ReflexionFailureRecord[] = [];
      const seen = new Set<string>();
      for (const value of loaded) {
        const record = parseReflexionFailureRecord(value);
        if (record === undefined || seen.has(record.recordDigest)) {
          throw new TypeError(
            "memory source returned an invalid or replayed record",
          );
        }
        seen.add(record.recordDigest);
        if (
          record.origin.taskId !== canonicalScope.currentTaskId &&
          record.origin.runId !== canonicalScope.currentRunId
        ) {
          records.push(record);
        }
      }
      records.sort((left, right) =>
        compareStrings(left.recordDigest, right.recordDigest),
      );
      return createSnapshot(canonicalScope, Object.freeze(records));
    },
  });
  queries.add(query);
  return query;
}

function isReflexionMemoryQuery(value: unknown): value is ReflexionMemoryQuery {
  return typeof value === "object" && value !== null && queries.has(value);
}

function parseReflexionMemorySnapshot(
  value: unknown,
): ReflexionMemorySnapshot | undefined {
  const snapshot = dataRecord(value, snapshotKeys, true);
  if (
    snapshot === undefined ||
    snapshot.schema !== "skizzles.reflexion-memory/snapshot" ||
    snapshot.domain !== "reflexion-failure-memory" ||
    snapshot.version !== 1 ||
    !isReflexionDigest(snapshot.snapshotDigest)
  ) {
    return;
  }
  let scope: ReflexionMemoryScope;
  try {
    scope = parseScope(snapshot.scope, true);
  } catch {
    return;
  }
  const values = strictFrozenArray(snapshot.records);
  if (values === undefined || values.length > maximumRecordCount) {
    return;
  }
  const records: ReflexionFailureRecord[] = [];
  for (const valueRecord of values) {
    const record = parseReflexionFailureRecord(valueRecord);
    if (record === undefined) {
      return;
    }
    records.push(record);
  }
  if (
    new Set(records.map((record) => record.recordDigest)).size !==
      records.length ||
    records.some(
      (record, index) =>
        (index > 0 &&
          compareStrings(
            records[index - 1]?.recordDigest ?? "",
            record.recordDigest,
          ) >= 0) ||
        record.origin.taskId === scope.currentTaskId ||
        record.origin.runId === scope.currentRunId,
    )
  ) {
    return;
  }
  const immutableRecords = Object.freeze(records);
  if (
    digestSnapshotMaterial(scope, immutableRecords) !== snapshot.snapshotDigest
  ) {
    return;
  }
  return createSnapshot(scope, immutableRecords);
}

function parseScope(
  value: unknown,
  requireFrozen: boolean,
): ReflexionMemoryScope {
  const scope = dataRecord(value, scopeKeys, requireFrozen);
  if (scope === undefined) {
    throw new TypeError("memory scopes must use exact data properties");
  }
  return Object.freeze({
    currentTaskId: normalizeIdentifier(scope.currentTaskId, "currentTaskId"),
    currentRunId: normalizeIdentifier(scope.currentRunId, "currentRunId"),
  });
}

function createSnapshot(
  scope: ReflexionMemoryScope,
  records: readonly ReflexionFailureRecord[],
): ReflexionMemorySnapshot {
  return Object.freeze({
    schema: "skizzles.reflexion-memory/snapshot" as const,
    domain: "reflexion-failure-memory" as const,
    version: 1 as const,
    scope,
    records,
    snapshotDigest: digestSnapshotMaterial(scope, records),
  });
}

function digestSnapshotMaterial(
  scope: ReflexionMemoryScope,
  records: readonly ReflexionFailureRecord[],
): ReflexionDigest {
  return digestCanonical({
    schema: "skizzles.reflexion-memory/snapshot",
    domain: "reflexion-failure-memory",
    version: 1,
    scope: {
      currentTaskId: scope.currentTaskId,
      currentRunId: scope.currentRunId,
    },
    recordDigests: records.map((record) => record.recordDigest),
  });
}

export {
  createReflexionMemoryQuery,
  isReflexionMemoryQuery,
  parseReflexionMemorySnapshot,
};
