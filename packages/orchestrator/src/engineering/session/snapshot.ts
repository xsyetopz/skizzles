import { types } from "node:util";

export type OwnSnapshot = Readonly<Record<string, unknown>>;

export function snapshotRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): OwnSnapshot | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return;
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return;
  }
  const descriptors = readDescriptors(value, keys);
  if (descriptors === undefined) return;
  if (keys.some((key) => typeof key === "symbol")) return;
  const actual = keys.filter((key): key is string => typeof key === "string");
  if (
    required.some((key) => !actual.includes(key)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    return;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of actual) {
    const descriptor = descriptors.get(key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

export function snapshotOpaqueRecord(
  value: unknown,
  required: readonly string[],
): OwnSnapshot | undefined {
  if (!isFrozenOpaque(value) || Array.isArray(value)) return;
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return;
  }
  const stringKeys = keys.filter(
    (key): key is string => typeof key === "string",
  );
  if (
    keys.length !== stringKeys.length ||
    stringKeys.length !== required.length ||
    required.some((key) => !stringKeys.includes(key))
  ) {
    return;
  }
  const descriptors = readDescriptors(value, keys);
  if (descriptors === undefined) return;
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of stringKeys) {
    const descriptor = descriptors.get(key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

export function hasOwnDataMethods(
  value: unknown,
  methods: readonly string[],
): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return false;
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (keys.some((key) => typeof key === "symbol")) return false;
  const descriptors = readDescriptors(value, keys);
  if (descriptors === undefined) return false;
  return methods.every((method) => {
    const descriptor = descriptors.get(method);
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "function"
    );
  });
}

export function snapshotArray(
  value: unknown,
  maximum: number,
): readonly unknown[] | undefined {
  if (!Array.isArray(value) || types.isProxy(value)) return;
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return;
  }
  const descriptors = readDescriptors(value, keys);
  if (descriptors === undefined) return;
  if (keys.some((key) => typeof key === "symbol")) return;
  const lengthDescriptor = descriptors.get("length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum
  ) {
    return;
  }
  const length = lengthDescriptor.value;
  const expected = new Set(["length"]);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    expected.add(key);
    const descriptor = descriptors.get(key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return;
    }
    result.push(descriptor.value);
  }
  if (keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    return;
  }
  return Object.freeze(result);
}

export function isFrozenOpaque(value: unknown): value is object {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    return false;
  }
  try {
    if (!Object.isFrozen(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) return false;
    const descriptors = readDescriptors(value, keys);
    return (
      descriptors !== undefined &&
      keys.every((key) => {
        const descriptor = descriptors.get(key);
        return descriptor !== undefined && "value" in descriptor;
      })
    );
  } catch {
    return false;
  }
}

function readDescriptors(
  value: object,
  keys: readonly PropertyKey[],
): ReadonlyMap<PropertyKey, PropertyDescriptor> | undefined {
  const descriptors = new Map<PropertyKey, PropertyDescriptor>();
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return;
      descriptors.set(key, descriptor);
    }
  } catch {
    return;
  }
  return descriptors;
}
