import { createHash } from "node:crypto";

import type { ReflexionDigest } from "./contract.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const identifierPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,255})$/u;
const drivePrefixPattern = /^[A-Za-z]:/u;
const maximumRelativePathLength = 4096;

export function digestCanonical(value: unknown): ReflexionDigest {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

export function isReflexionDigest(value: unknown): value is ReflexionDigest {
  return typeof value === "string" && digestPattern.test(value);
}

export function normalizeIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    !identifierPattern.test(value) ||
    value.includes("//") ||
    value.includes("..") ||
    value.endsWith("/")
  ) {
    throw new TypeError(`${field} must be a canonical bounded identifier`);
  }
  return value;
}

export function normalizeText(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.normalize("NFC") ||
    value !== value.trim() ||
    value.includes("\u0000")
  ) {
    throw new TypeError(`${field} must be canonical bounded text`);
  }
  return value;
}

export function normalizeRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumRelativePathLength ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    drivePrefixPattern.test(value)
  ) {
    throw new TypeError(
      "skill paths must be portable canonical relative paths",
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError("skill paths must not contain aliases or traversal");
  }
  return value;
}

export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
