import { posix } from "node:path";
import { types } from "node:util";
import type { Digest } from "../../digest.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function objectValue(value: unknown): object | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return;
  }
  return value;
}

export function frozenRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (!Object.isFrozen(value)) return;
  const record = snapshotRecord(value);
  return exactKeys(record, keys) ? record : undefined;
}

export function snapshotRecord(
  value: unknown,
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      return;
    result.set(key, descriptor.value);
  }
  return result;
}

export function exactKeys(
  record: ReadonlyMap<string, unknown> | undefined,
  keys: readonly string[],
): record is ReadonlyMap<string, unknown> {
  return (
    record !== undefined &&
    record.size === keys.length &&
    keys.every((key) => record.has(key))
  );
}

export function frozenArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || !Object.isFrozen(value))
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      return false;
  }
  return true;
}

export function stringList(
  value: unknown,
  maximum: number,
): readonly string[] | undefined {
  if (!frozenArray(value) || value.length > maximum) return;
  const result: string[] = [];
  for (const item of value) {
    if (!identity(item, 256) || result.includes(item)) return;
    result.push(item);
  }
  return Object.freeze(result.sort((left, right) => left.localeCompare(right)));
}

export function identity(value: unknown, maximum = 128): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= maximum &&
    identifierPattern.test(value)
  );
}

export function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maximum
  );
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}

export function sourcePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  )
    return false;
  const normalized = posix.normalize(value);
  return (
    normalized === value &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(value)
  );
}
