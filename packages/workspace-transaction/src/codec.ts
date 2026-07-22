import { posix } from "node:path";

const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const MAX_TARGET_PATH_LENGTH = 1024;

export function compareCanonicalText(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export type UnknownRecord = Readonly<Record<string, unknown>> &
  Readonly<{
    approvalDigest?: unknown;
    approvalReference?: unknown;
    baselineDigest?: unknown;
    bindings?: unknown;
    byteLength?: unknown;
    candidate?: unknown;
    candidateBytes?: unknown;
    contentDigest?: unknown;
    deviceId?: unknown;
    expected?: unknown;
    identity?: unknown;
    journalDigest?: unknown;
    linkCount?: unknown;
    name?: unknown;
    operation?: unknown;
    ownerId?: unknown;
    path?: unknown;
    repositoryId?: unknown;
    requestDigest?: unknown;
    retiredName?: unknown;
    rootIdentity?: unknown;
    state?: unknown;
    targetSetDigest?: unknown;
    targets?: unknown;
    transactionId?: unknown;
    version?: unknown;
  }>;

export function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      return;
    }
    const descriptor: unknown = Reflect.get(descriptors, key);
    if (
      typeof descriptor !== "object" ||
      descriptor === null ||
      Reflect.get(descriptor, "enumerable") !== true ||
      !("value" in descriptor)
    ) {
      return;
    }
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return snapshot as UnknownRecord;
}

export function snapshotArray(
  value: unknown,
  maxLength: number,
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor: unknown = Reflect.get(descriptors, "length");
  if (
    typeof lengthDescriptor !== "object" ||
    lengthDescriptor === null ||
    !("value" in lengthDescriptor)
  ) {
    return;
  }
  const length = lengthDescriptor.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maxLength
  ) {
    return;
  }
  const snapshot: unknown[] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      return;
    }
    if (key === "length") {
      continue;
    }
    const index = Number(key);
    const descriptor: unknown = Reflect.get(descriptors, key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= length ||
      String(index) !== key ||
      typeof descriptor !== "object" ||
      descriptor === null ||
      Reflect.get(descriptor, "enumerable") !== true ||
      !("value" in descriptor)
    ) {
      return;
    }
    snapshot[index] = descriptor.value;
  }
  return snapshot.length === length &&
    snapshot.every((_entry, index) => index in snapshot)
    ? snapshot
    : undefined;
}

export function hasExactKeys(
  record: UnknownRecord,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(record).sort(compareCanonicalText);
  const expected = [...keys].sort(compareCanonicalText);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function parseBoundedString(
  value: unknown,
  options: Readonly<{ min?: number; max: number; pattern?: RegExp }>,
): string | undefined {
  const min = options.min ?? 1;
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > options.max ||
    value.includes("\0") ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    return;
  }
  return value;
}

export function parseByteArray(
  value: unknown,
  maxBytes: number,
): Uint8Array | undefined {
  const snapshot = snapshotArray(value, maxBytes);
  if (snapshot === undefined) {
    return;
  }
  const bytes = new Uint8Array(snapshot.length);
  for (const [index, byte] of snapshot.entries()) {
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    ) {
      return;
    }
    bytes[index] = byte;
  }
  return bytes;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export function normalizeTargetPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TARGET_PATH_LENGTH ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    hasLoneSurrogate(value) ||
    WINDOWS_DRIVE.test(value)
  ) {
    return undefined;
  }
  const normalized = posix.normalize(value.normalize("NFC"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  ) {
    return undefined;
  }
  return normalized;
}
