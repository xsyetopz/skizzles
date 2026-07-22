import { createHash } from "node:crypto";
import { types } from "node:util";
import type { DataRecord } from "./authority-state.ts";
import type { SourceEvidenceFailureCode } from "./contract.ts";

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const MAXIMUM_NODE_SOURCE_BYTES = 262_144;
export const MAXIMUM_BASELINE_BYTES = 4_194_304;

export function frozenBytes(
  value: unknown,
  maximum: number,
): readonly number[] | undefined {
  if (
    !(denseDataArray(value) && Object.isFrozen(value)) ||
    value.length > maximum ||
    value.some(
      (byte) =>
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255,
    )
  ) {
    return;
  }
  const bytes: number[] = [];
  for (const byte of value) {
    if (typeof byte !== "number") return;
    bytes.push(byte);
  }
  return Object.freeze(bytes);
}

export function plainRecord(
  value: unknown,
  keys: readonly string[],
): value is DataRecord {
  if (!plainRecordShape(value) || types.isProxy(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return (
      Reflect.ownKeys(value).every((key) => typeof key === "string") &&
      Object.keys(descriptors).length === keys.length &&
      keys.every(
        (key) =>
          Object.hasOwn(descriptors, key) &&
          "value" in (descriptors[key] ?? {}) &&
          descriptors[key]?.enumerable === true,
      )
    );
  } catch {
    return false;
  }
}

export function plainDataRecord(
  value: unknown,
  keys: readonly string[],
): value is DataRecord {
  if (!plainRecord(value, keys)) return false;
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

export function plainRecordShape(value: unknown): value is DataRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function denseDataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || types.isProxy(value)) return false;
  try {
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function sourcePath(value: unknown): value is string {
  if (
    !boundedString(value, 4096) ||
    value.startsWith("/") ||
    value.includes("\\")
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function digestString(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

export function boundedString(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maximumBytes
  );
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function digestBytes(value: readonly number[]): string {
  return `sha256:${createHash("sha256").update(Uint8Array.from(value)).digest("hex")}`;
}

export function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestValue(value: unknown): string {
  return digestText(JSON.stringify(value));
}

export function rejected(code: SourceEvidenceFailureCode): {
  readonly status: "rejected";
  readonly code: SourceEvidenceFailureCode;
} {
  return Object.freeze({ status: "rejected", code });
}
