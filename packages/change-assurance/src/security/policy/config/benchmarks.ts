import { types } from "node:util";
import type { SecurityBenchmark } from "../../contract.ts";
import {
  identity,
  optionalPositiveInteger,
  optionalRecord,
  optionalStringArray,
} from "./values.ts";

export function parseBenchmarks(
  value: unknown,
): readonly SecurityBenchmark[] | undefined {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    value.length === 0 ||
    value.length > 256
  )
    return;
  const result: SecurityBenchmark[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const record = optionalRecord(
      item,
      [
        "benchmarkId",
        "minimumRateLimitRequests",
        "maximumRateLimitWindowMs",
        "maximumRequestBytes",
        "requiredAuditFields",
        "sanitizerNames",
      ],
      ["benchmarkId"],
    );
    if (record === undefined) return;
    const benchmarkId = identity(record["benchmarkId"]);
    const minimumRateLimitRequests = optionalPositiveInteger(
      record["minimumRateLimitRequests"],
    );
    const maximumRateLimitWindowMs = optionalPositiveInteger(
      record["maximumRateLimitWindowMs"],
    );
    const maximumRequestBytes = optionalPositiveInteger(
      record["maximumRequestBytes"],
    );
    const requiredAuditFields = optionalStringArray(
      record["requiredAuditFields"],
    );
    const sanitizerNames = optionalStringArray(record["sanitizerNames"]);
    if (
      benchmarkId === undefined ||
      ids.has(benchmarkId) ||
      minimumRateLimitRequests === false ||
      maximumRateLimitWindowMs === false ||
      maximumRequestBytes === false ||
      requiredAuditFields === false ||
      sanitizerNames === false
    )
      return;
    ids.add(benchmarkId);
    result.push(
      Object.freeze({
        benchmarkId,
        ...(minimumRateLimitRequests === undefined
          ? {}
          : { minimumRateLimitRequests }),
        ...(maximumRateLimitWindowMs === undefined
          ? {}
          : { maximumRateLimitWindowMs }),
        ...(maximumRequestBytes === undefined ? {} : { maximumRequestBytes }),
        ...(requiredAuditFields === undefined
          ? {}
          : { requiredAuditFields: Object.freeze(requiredAuditFields) }),
        ...(sanitizerNames === undefined
          ? {}
          : { sanitizerNames: Object.freeze(sanitizerNames) }),
      }),
    );
  }
  return Object.freeze(result);
}
