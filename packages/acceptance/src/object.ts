import { types } from "node:util";

export function dataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    !Object.isFrozen(value)
  )
    return;
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return;
  }
  if (
    ownKeys.length !== keys.length ||
    keys.some((key) => !ownKeys.includes(key))
  )
    return;
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    result[key] = descriptor.value;
  }
  return result;
}

export function frozenArray(value: unknown): readonly unknown[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    types.isProxy(value)
  ) {
    return;
  }
  return value;
}

export function opaqueEvidence(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    !types.isProxy(value) &&
    Object.isFrozen(value)
  );
}

export function identifier(value: unknown, maximum = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(value)
  );
}

export function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
