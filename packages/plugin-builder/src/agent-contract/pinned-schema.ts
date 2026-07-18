import { createHash } from "node:crypto";
import {
  AgentContractPackageError,
  PINNED_SCHEMA_DIGESTS,
} from "./contract.ts";

/**
 * Plugin composition intentionally pins the exact published schema bytes.
 * Runtime instance semantics belong to the strict TypeScript evaluators; this
 * function is not a partial JSON Schema meta-validator.
 */
export function validatePinnedSchema(path: string, bytes: Buffer): void {
  const expected =
    PINNED_SCHEMA_DIGESTS[path as keyof typeof PINNED_SCHEMA_DIGESTS];
  if (expected === undefined) {
    throw new AgentContractPackageError(
      "Agent contract schema has no pinned composition authority.",
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new AgentContractPackageError(
      "Agent contract schema does not match its pinned publication.",
    );
  }
}
