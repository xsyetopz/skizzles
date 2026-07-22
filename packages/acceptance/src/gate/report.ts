import type { VerificationBindings } from "../contract.ts";
import type { VerificationDigest } from "../digest.ts";
import { digestValue, isDigest } from "../digest.ts";
import { dataRecord, frozenArray, identifier } from "../object.ts";

export function bindingDigest(
  bindings: VerificationBindings,
): VerificationDigest {
  return digestValue(bindings);
}

export function validReport(
  raw: unknown,
  keys: readonly string[],
  bindings: VerificationBindings,
): Readonly<Record<string, unknown>> | undefined {
  const record = dataRecord(raw, keys);
  if (
    record === undefined ||
    record["status"] !== "valid" ||
    record["bindingDigest"] !== bindingDigest(bindings)
  ) {
    return;
  }
  return record;
}

export function digests(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => isDigest(record[key]));
}

export function identifierArray(
  raw: unknown,
  allowed?: ReadonlySet<string>,
): readonly string[] | undefined {
  const values = frozenArray(raw);
  if (values === undefined) return;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (
      !identifier(value) ||
      seen.has(value) ||
      (allowed !== undefined && !allowed.has(value))
    ) {
      return;
    }
    seen.add(value);
    result.push(value);
  }
  return Object.freeze(result);
}
