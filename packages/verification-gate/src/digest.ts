import { createHash } from "node:crypto";

export type VerificationDigest = `sha256:${string}`;

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export function digestValue(value: unknown): VerificationDigest {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function isDigest(value: unknown): value is VerificationDigest {
  return typeof value === "string" && digestPattern.test(value);
}
