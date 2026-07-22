import { types } from "node:util";

export type Snapshot = Readonly<Record<string, unknown>>;

export function snapshotRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Snapshot | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input)
  ) {
    return;
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(input);
  } catch {
    return;
  }
  const names: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") return;
    names.push(key);
  }
  if (
    required.some((key) => !names.includes(key)) ||
    names.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    return;
  }
  const result: Record<string, unknown> = Object.create(null);
  try {
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return;
      }
      result[key] = descriptor.value;
    }
  } catch {
    return;
  }
  return Object.freeze(result);
}

export function snapshotFrozenArray(
  input: unknown,
  maximum: number,
): readonly unknown[] | undefined {
  if (
    !Array.isArray(input) ||
    types.isProxy(input) ||
    !Object.isFrozen(input)
  ) {
    return;
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(input);
  } catch {
    return;
  }
  const length = input.length;
  if (!Number.isSafeInteger(length) || length < 1 || length > maximum) return;
  const expected = new Set<string>(["length"]);
  const result: unknown[] = [];
  try {
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      expected.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return;
      }
      result.push(descriptor.value);
    }
  } catch {
    return;
  }
  if (keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    return;
  }
  return Object.freeze(result);
}

export function isFrozenDataObject(input: unknown): input is object {
  if (
    typeof input !== "object" ||
    input === null ||
    types.isProxy(input) ||
    !Object.isFrozen(input)
  ) {
    return false;
  }
  try {
    return Reflect.ownKeys(input).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor !== undefined && "value" in descriptor;
    });
  } catch {
    return false;
  }
}
