import { createHash } from "node:crypto";
import { compareCanonicalText } from "./codec.ts";

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestText(value: string): string {
  return digestBytes(new TextEncoder().encode(value));
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("canonical JSON accepts only safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareCanonicalText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("unsupported canonical JSON value");
}

export function digestValue(value: unknown): string {
  return digestText(canonicalJson(value));
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
