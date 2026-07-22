import { createHash } from "node:crypto";

export type Digest = `sha256:${string}`;
export type AssuranceDigest = Digest;

export function digestBytes(value: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestValue(value: unknown): Digest {
  return digestBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export function copyBytes(value: Uint8Array): readonly number[] {
  return Object.freeze(Array.from(value));
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
