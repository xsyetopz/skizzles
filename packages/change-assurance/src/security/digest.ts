import { createHash } from "node:crypto";
import type { SecurityDigest } from "./contract.ts";

export function digestBytes(bytes: Uint8Array): SecurityDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digestValue(value: unknown): SecurityDigest {
  return digestBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export function bytesFromCandidate(
  value: readonly number[] | null,
): Uint8Array | undefined {
  if (value === null || !validByteArray(value)) return;
  return Uint8Array.from(value);
}

function validByteArray(value: readonly number[]): boolean {
  return (
    value.length <= 16_777_216 &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  );
}
