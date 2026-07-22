import { types } from "node:util";
import type { TaskWorktreeDigest } from "../../digest.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export function parseActionInput(
  input: unknown,
): Readonly<{ version: 1; session: unknown }> | undefined {
  const values = exactRecord(input, ["session", "version"]);
  return values?.get("version") === 1 && Object.isFrozen(input)
    ? Object.freeze({ version: 1 as const, session: values.get("session") })
    : undefined;
}

export function isTaskWorktreeDigest(
  value: unknown,
): value is TaskWorktreeDigest {
  return typeof value === "string" && digestPattern.test(value);
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    return;
  const values = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    values.set(key, descriptor.value);
  }
  return values;
}
