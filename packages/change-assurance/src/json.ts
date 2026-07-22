import { types } from "node:util";
import type { AssuranceJsonValue } from "./contract.ts";

const maximumDepth = 32;
const maximumNodes = 16_384;
const maximumStringLength = 262_144;

interface CloneBudget {
  nodes: number;
}

export function cloneJson(input: unknown): AssuranceJsonValue | undefined {
  return cloneValue(input, 0, { nodes: 0 });
}

function cloneValue(
  input: unknown,
  depth: number,
  budget: CloneBudget,
): AssuranceJsonValue | undefined {
  budget.nodes += 1;
  if (depth > maximumDepth || budget.nodes > maximumNodes) return;
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    return input.length <= maximumStringLength ? input : undefined;
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : undefined;
  }
  if (Array.isArray(input)) {
    const keys = Object.keys(input);
    if (
      keys.length !== input.length ||
      keys.some((key, index) => key !== String(index))
    )
      return;
    const output: AssuranceJsonValue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return;
      const cloned = cloneValue(descriptor.value, depth + 1, budget);
      if (cloned === undefined) return;
      output.push(cloned);
    }
    return Object.freeze(output);
  }
  if (!isPlainRecord(input)) return;
  const output: Record<string, AssuranceJsonValue> = Object.create(null);
  const keys = Object.keys(input).sort((left, right) =>
    left.localeCompare(right),
  );
  for (const key of keys) {
    if (key.length === 0 || key.length > 256) return;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    const cloned = cloneValue(descriptor.value, depth + 1, budget);
    if (cloned === undefined) return;
    output[key] = cloned;
  }
  return Object.freeze(output);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    types.isProxy(value) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string")
  )
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
