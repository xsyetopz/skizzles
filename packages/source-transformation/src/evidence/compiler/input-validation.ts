import { relative, sep } from "node:path";
import { types } from "node:util";
import type { Digest } from "../../digest.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumPathLength = 1024;

export function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}

export function validId(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\0\r\n]/u.test(value)
  );
}

export function validPath(value: unknown): value is string {
  return (
    validId(value, maximumPathLength) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}

export function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== "..");
}

export function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return;
  }
  const keys = Reflect.ownKeys(value);
  const allowed = [...required, ...optional];
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    return;
  }
  const result = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return;
    }
    result.set(key, descriptor.value);
  }
  return result;
}
