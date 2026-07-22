import type {
  JsonSemanticComparisonResult,
  JsonSemanticDifference,
} from "../contract.ts";
import { captureJsonSemanticValue } from "./capture.ts";
import { findJsonSemanticDifference } from "./difference.ts";
import type { SnapshotResult } from "./domain.ts";

function compare(
  actual: unknown,
  expected: unknown,
): JsonSemanticComparisonResult {
  try {
    const actualSnapshot = captureJsonSemanticValue(actual);
    if (actualSnapshot.status === "rejected") {
      return rejected("actual", actualSnapshot);
    }
    const expectedSnapshot = captureJsonSemanticValue(expected);
    if (expectedSnapshot.status === "rejected") {
      return rejected("expected", expectedSnapshot);
    }
    const difference = findJsonSemanticDifference(
      actualSnapshot.node,
      expectedSnapshot.node,
    );
    if (difference === undefined) {
      return Object.freeze({ status: "equal", domain: "json-value" });
    }
    return Object.freeze({
      status: "different",
      domain: "json-value",
      difference: freezeDifference(difference),
    });
  } catch {
    return Object.freeze({
      status: "rejected",
      domain: "json-value",
      side: "actual",
      code: "UNSAFE_OBJECT",
      path: Object.freeze([]),
    });
  }
}

function freezeDifference(
  value: JsonSemanticDifference,
): JsonSemanticDifference {
  return Object.freeze({
    ...value,
    path: Object.freeze([...value.path]),
  });
}

function rejected(
  side: "actual" | "expected",
  result: Extract<SnapshotResult, { status: "rejected" }>,
): JsonSemanticComparisonResult {
  return Object.freeze({
    status: "rejected",
    domain: "json-value",
    side,
    code: result.code,
    path: Object.freeze([...result.path]),
  });
}

/**
 * Compares values in the language-neutral JSON value domain.
 *
 * Scalar kinds never coerce, object member order is insignificant, and array
 * order remains significant. Values outside the JSON domain reject instead of
 * being silently normalized or ignored.
 */
export function compareJsonSemantics(
  actual: unknown,
  expected: unknown,
): JsonSemanticComparisonResult {
  return compare(actual, expected);
}
