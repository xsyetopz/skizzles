import type { JsonSemanticRejectionCode } from "../contract.ts";
import {
  appendSemanticPath,
  compareSemanticNames,
  type SemanticNode,
  type SnapshotResult,
} from "./domain.ts";

const maximumDepth = 128;
const maximumNodes = 100_000;

interface SnapshotState {
  readonly active: WeakSet<object>;
  nodes: number;
}

function snapshot(
  value: unknown,
  path: readonly (number | string)[],
  state: SnapshotState,
  depth: number,
): SnapshotResult {
  state.nodes += 1;
  if (depth > maximumDepth || state.nodes > maximumNodes) {
    return rejected("LIMIT_EXCEEDED", path);
  }
  if (value === null) {
    return captured(Object.freeze({ kind: "null" }));
  }
  if (typeof value === "boolean") {
    return captured(Object.freeze({ kind: "boolean", value }));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return rejected("UNSUPPORTED_VALUE", path);
    }
    return captured(Object.freeze({ kind: "number", value }));
  }
  if (typeof value === "string") {
    return captured(Object.freeze({ kind: "string", value }));
  }
  if (typeof value !== "object") {
    return rejected("UNSUPPORTED_VALUE", path);
  }
  if (state.active.has(value)) {
    return rejected("CYCLIC_VALUE", path);
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      return snapshotArray(value, path, state, depth);
    }
    return snapshotObject(value, path, state, depth);
  } finally {
    state.active.delete(value);
  }
}

function snapshotArray(
  value: readonly unknown[],
  path: readonly (number | string)[],
  state: SnapshotState,
  depth: number,
): SnapshotResult {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !isArrayIndex(key, value.length)),
    )
  ) {
    return rejected("UNSAFE_OBJECT", path);
  }
  const values: SemanticNode[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    const itemPath = appendSemanticPath(path, index);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return rejected("UNSAFE_OBJECT", itemPath);
    }
    const result = snapshot(descriptor.value, itemPath, state, depth + 1);
    if (result.status === "rejected") {
      return result;
    }
    values.push(result.node);
  }
  return captured(
    Object.freeze({ kind: "array", values: Object.freeze(values) }),
  );
}

function snapshotObject(
  value: object,
  path: readonly (number | string)[],
  state: SnapshotState,
  depth: number,
): SnapshotResult {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return rejected("UNSAFE_OBJECT", path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return rejected("UNSAFE_OBJECT", path);
  }
  const names = keys.filter((key): key is string => typeof key === "string");
  names.sort(compareSemanticNames);
  const values = new Map<string, SemanticNode>();
  for (const name of names) {
    const descriptor = descriptors[name];
    const memberPath = appendSemanticPath(path, name);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return rejected("UNSAFE_OBJECT", memberPath);
    }
    const result = snapshot(descriptor.value, memberPath, state, depth + 1);
    if (result.status === "rejected") {
      return result;
    }
    values.set(name, result.node);
  }
  return captured(Object.freeze({ kind: "object", values }));
}

function captured(node: SemanticNode): SnapshotResult {
  return { status: "captured", node };
}

function rejected(
  code: JsonSemanticRejectionCode,
  path: readonly (number | string)[],
): SnapshotResult {
  return { status: "rejected", code, path };
}

function isArrayIndex(value: string, length: number): boolean {
  const index = Number(value);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === value
  );
}

export function captureJsonSemanticValue(value: unknown): SnapshotResult {
  try {
    return snapshot(value, [], { active: new WeakSet<object>(), nodes: 0 }, 0);
  } catch {
    return rejected("UNSAFE_OBJECT", []);
  }
}
