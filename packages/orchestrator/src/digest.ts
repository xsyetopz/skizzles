import { createHash } from "node:crypto";

export type Digest = `sha256:${string}`;

export function digestBytes(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digestValue(value: unknown): Digest {
  return digestBytes(new TextEncoder().encode(JSON.stringify(value)));
}
