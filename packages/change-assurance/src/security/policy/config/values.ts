import { types } from "node:util";

export function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    result[key] = descriptor.value;
  }
  return result;
}

export function optionalRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return;
  const own = Reflect.ownKeys(value);
  if (
    own.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !own.includes(key))
  )
    return;
  const result: Record<string, unknown> = {};
  for (const key of own) {
    if (typeof key !== "string") return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    result[key] = descriptor.value;
  }
  return result;
}

export function identity(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0")
  )
    return;
  return value;
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 128)
    return;
  const result: string[] = [];
  for (const item of value) {
    const parsed = identity(item);
    if (parsed === undefined || result.includes(parsed)) return;
    result.push(parsed);
  }
  return result;
}

export function optionalStringArray(
  value: unknown,
): string[] | undefined | false {
  if (value === undefined) return;
  const parsed = stringArray(value);
  return parsed ?? false;
}

export function optionalPositiveInteger(
  value: unknown,
): number | undefined | false {
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 2 ** 31)
    return false;
  return Number(value);
}
