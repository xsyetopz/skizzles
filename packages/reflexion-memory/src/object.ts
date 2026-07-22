import { types } from "node:util";

export function dataRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  requireFrozen: boolean,
): Readonly<Record<Keys[number], unknown>> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    (requireFrozen && !Object.isFrozen(value))
  ) {
    return;
  }
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return;
  }
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    keys.some((key) => !ownKeys.includes(key))
  ) {
    return;
  }
  const record = Object.create(null) as Record<Keys[number], unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return;
    }
    record[key as Keys[number]] = descriptor.value;
  }
  return record;
}

export function strictFrozenArray(
  value: unknown,
): readonly unknown[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    types.isProxy(value)
  ) {
    return;
  }
  return value;
}

export function isProxy(value: object): boolean {
  return types.isProxy(value);
}
