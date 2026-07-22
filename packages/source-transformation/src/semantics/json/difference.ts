import type {
  JsonSemanticDifference,
  JsonSemanticValueKind,
} from "../contract.ts";
import {
  appendSemanticPath,
  compareSemanticNames,
  type SemanticNode,
} from "./domain.ts";

function compareNodes(
  actual: SemanticNode,
  expected: SemanticNode,
  path: readonly (number | string)[],
): JsonSemanticDifference | undefined {
  if (actual.kind !== expected.kind) {
    return difference("KIND_MISMATCH", path, actual.kind, expected.kind);
  }
  switch (actual.kind) {
    case "null":
      return;
    case "boolean":
    case "number":
    case "string":
      if (expected.kind === actual.kind && actual.value === expected.value) {
        return;
      }
      return difference("VALUE_MISMATCH", path, actual.kind, expected.kind);
    case "array":
      if (expected.kind !== "array") {
        return difference("KIND_MISMATCH", path, actual.kind, expected.kind);
      }
      return compareArrays(actual.values, expected.values, path);
    case "object":
      if (expected.kind !== "object") {
        return difference("KIND_MISMATCH", path, actual.kind, expected.kind);
      }
      return compareObjects(actual.values, expected.values, path);
    default:
      return;
  }
}

function compareArrays(
  actual: readonly SemanticNode[],
  expected: readonly SemanticNode[],
  path: readonly (number | string)[],
): JsonSemanticDifference | undefined {
  const sharedLength = Math.min(actual.length, expected.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const actualNode = actual[index];
    const expectedNode = expected[index];
    if (actualNode === undefined || expectedNode === undefined) {
      return difference(
        "KIND_MISMATCH",
        appendSemanticPath(path, index),
        "missing",
        "missing",
      );
    }
    const nested = compareNodes(
      actualNode,
      expectedNode,
      appendSemanticPath(path, index),
    );
    if (nested !== undefined) {
      return nested;
    }
  }
  if (actual.length < expected.length) {
    const expectedNode = expected[actual.length];
    return difference(
      "MISSING_MEMBER",
      appendSemanticPath(path, actual.length),
      "missing",
      expectedNode?.kind ?? "missing",
    );
  }
  if (actual.length > expected.length) {
    const actualNode = actual[expected.length];
    return difference(
      "UNEXPECTED_MEMBER",
      appendSemanticPath(path, expected.length),
      actualNode?.kind ?? "missing",
      "missing",
    );
  }
  return;
}

function compareObjects(
  actual: ReadonlyMap<string, SemanticNode>,
  expected: ReadonlyMap<string, SemanticNode>,
  path: readonly (number | string)[],
): JsonSemanticDifference | undefined {
  const names = new Set([...actual.keys(), ...expected.keys()]);
  for (const name of [...names].sort(compareSemanticNames)) {
    const actualNode = actual.get(name);
    const expectedNode = expected.get(name);
    if (actualNode === undefined) {
      return difference(
        "MISSING_MEMBER",
        appendSemanticPath(path, name),
        "missing",
        expectedNode?.kind ?? "missing",
      );
    }
    if (expectedNode === undefined) {
      return difference(
        "UNEXPECTED_MEMBER",
        appendSemanticPath(path, name),
        actualNode.kind,
        "missing",
      );
    }
    const nested = compareNodes(
      actualNode,
      expectedNode,
      appendSemanticPath(path, name),
    );
    if (nested !== undefined) {
      return nested;
    }
  }
  return;
}

function difference(
  code: JsonSemanticDifference["code"],
  path: readonly (number | string)[],
  actualKind: JsonSemanticValueKind,
  expectedKind: JsonSemanticValueKind,
): JsonSemanticDifference {
  return { code, path, actualKind, expectedKind };
}

export function findJsonSemanticDifference(
  actual: SemanticNode,
  expected: SemanticNode,
): JsonSemanticDifference | undefined {
  return compareNodes(actual, expected, []);
}
