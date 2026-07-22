import { createHash } from "node:crypto";

export type Digest = `sha256:${string}`;

export function digestBytes(value: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestText(value: string): Digest {
  return digestBytes(new TextEncoder().encode(value));
}
