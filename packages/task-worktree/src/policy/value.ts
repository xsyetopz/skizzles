import { createHash } from "node:crypto";
import { types } from "node:util";

export function isPlainDataRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (descriptor.get !== undefined || descriptor.set !== undefined)
      return false;
  }
  return true;
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isDensePlainArray(value: unknown): value is readonly unknown[] {
  if (types.isProxy(value)) return false;
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return false;
    }
  }
  return true;
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function freezeBytes(
  value: readonly number[],
): readonly number[] | null {
  if (!isDensePlainArray(value)) return null;
  const bytes: number[] = [];
  for (const byte of value) {
    if (
      !Number.isInteger(byte) ||
      typeof byte !== "number" ||
      byte < 0 ||
      byte > 255
    ) {
      return null;
    }
    bytes.push(byte);
  }
  return Object.freeze(bytes);
}

export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024)
    return false;
  if (value !== value.normalize("NFC")) return false;
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/"))
    return false;
  if (/^[A-Za-z]:/.test(value) || value.endsWith("/") || value.includes("//"))
    return false;
  const segments = value.split("/");
  return segments.every((segment) => {
    if (segment === "" || segment === "." || segment === "..") return false;
    return segment.toLowerCase() !== ".git";
  });
}
