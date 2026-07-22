import { createHash } from "node:crypto";
import { PromptLayerError } from "./lifecycle/contract.ts";

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateText(bytes: Buffer, label: string): void {
  if (
    bytes.includes(0) ||
    bytes.includes(13) ||
    bytes.byteLength === 0 ||
    bytes.at(-1) !== 10
  ) {
    throw new PromptLayerError(
      `${label} must be non-empty LF-only text ending in LF.`,
    );
  }
}
