import { AgentContractPackageError } from "../contract.ts";
import type { JsonValue } from "../json/value.ts";
import {
  assertArray,
  assertExactKeys,
  assertRecord,
  assertString,
  canonicalJson,
} from "../json/value.ts";

type MutationOperation = "add" | "remove" | "replace";

export function materializeMutations(
  control: JsonValue,
  value: JsonValue | undefined,
  label: string,
): JsonValue {
  const clone = JSON.parse(canonicalJson(control)) as JsonValue;
  const mutations = assertArray(value, `${label}.mutations`);
  for (const [index, item] of mutations.entries()) {
    applyMutation(clone, item, `${label}.mutations[${index}]`);
  }
  return clone;
}

function applyMutation(root: JsonValue, value: JsonValue, label: string): void {
  const mutation = assertRecord(value, label);
  assertExactKeys(mutation, ["op", "path", "value"], label);
  const operation = assertString(mutation["op"], `${label}.op`);
  if (
    operation !== "add" &&
    operation !== "copy" &&
    operation !== "remove" &&
    operation !== "replace"
  ) {
    throw new AgentContractPackageError(`${label}.op is unsupported.`);
  }
  const path = assertString(mutation["path"], `${label}.path`);
  const replacement = requiredValue(mutation["value"], `${label}.value`);
  if (operation === "copy") {
    const target = assertString(replacement, `${label}.value`);
    const copied = JSON.parse(
      canonicalJson(valueAtPointer(root, path, label)),
    ) as JsonValue;
    mutateAtPointer(root, target, "add", copied, label);
    return;
  }
  mutateAtPointer(root, path, operation, replacement, label);
}

function valueAtPointer(
  root: JsonValue,
  pointer: string,
  label: string,
): JsonValue {
  let current = root;
  for (const segment of pointerSegments(pointer, label)) {
    current = childAt(current, segment, label);
  }
  return current;
}

function mutateAtPointer(
  root: JsonValue,
  pointer: string,
  operation: MutationOperation,
  replacement: JsonValue,
  label: string,
): void {
  const segments = pointerSegments(pointer, label);
  const property = segments.pop();
  if (property === undefined) {
    throw new AgentContractPackageError(
      `${label}.path cannot target the root.`,
    );
  }
  let parent = root;
  for (const segment of segments) {
    parent = childAt(parent, segment, label);
  }
  if (Array.isArray(parent)) {
    mutateArray(parent, property, operation, replacement, label);
    return;
  }
  if (typeof parent !== "object" || parent === null) {
    throw new AgentContractPackageError(`${label}.path has a scalar parent.`);
  }
  const exists = property in parent;
  if ((operation === "replace" || operation === "remove") && !exists) {
    throw new AgentContractPackageError(`${label}.path does not exist.`);
  }
  if (operation === "remove") {
    delete parent[property];
  } else {
    parent[property] = replacement;
  }
}

function mutateArray(
  parent: JsonValue[],
  segment: string,
  operation: MutationOperation,
  replacement: JsonValue,
  label: string,
): void {
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new AgentContractPackageError(
      `${label}.path has an invalid array index.`,
    );
  }
  if (operation === "add") {
    if (index > parent.length) {
      throw new AgentContractPackageError(
        `${label}.path array index is out of range.`,
      );
    }
    parent.splice(index, 0, replacement);
    return;
  }
  if (index >= parent.length) {
    throw new AgentContractPackageError(
      `${label}.path array index is out of range.`,
    );
  }
  if (operation === "remove") {
    parent.splice(index, 1);
  } else {
    parent[index] = replacement;
  }
}

function childAt(value: JsonValue, segment: string, label: string): JsonValue {
  if (Array.isArray(value)) {
    const index = Number(segment);
    const child = Number.isSafeInteger(index) ? value[index] : undefined;
    if (child === undefined) {
      throw new AgentContractPackageError(`${label}.path does not exist.`);
    }
    return child;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    value[segment] === undefined
  ) {
    throw new AgentContractPackageError(`${label}.path does not exist.`);
  }
  return value[segment];
}

function pointerSegments(pointer: string, label: string): string[] {
  if (!pointer.startsWith("/") || pointer === "/") {
    throw new AgentContractPackageError(
      `${label}.path must be a non-root JSON pointer.`,
    );
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function requiredValue(value: JsonValue | undefined, label: string): JsonValue {
  if (value === undefined) {
    throw new AgentContractPackageError(`${label} is required.`);
  }
  return value;
}
