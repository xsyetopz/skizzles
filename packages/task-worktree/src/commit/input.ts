import { types } from "node:util";
import type {
  TaskWorktreeDiffReceipt,
  TaskWorktreeSlice,
} from "../diff/contract.ts";
import type { TaskWorktreeDigest } from "../digest.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import type { CommitSynthesisPolicy, OwnedPackagePath } from "./contract.ts";

export function parsePolicy(input: unknown): CommitSynthesisPolicy | undefined {
  if (
    !(
      isPlainFrozenRecord(input, ["maxSubjectLength", "ownedPackagePaths"]) &&
      hasDataProperty(input, "maxSubjectLength") &&
      hasDataProperty(input, "ownedPackagePaths")
    )
  )
    return;
  const maxSubjectLength = input["maxSubjectLength"];
  const rawOwnedPackagePaths = input["ownedPackagePaths"];
  if (
    typeof maxSubjectLength !== "number" ||
    !Number.isSafeInteger(maxSubjectLength) ||
    maxSubjectLength < 20 ||
    maxSubjectLength > 200
  )
    return;
  if (
    !(
      Array.isArray(rawOwnedPackagePaths) &&
      Object.isFrozen(rawOwnedPackagePaths)
    )
  )
    return;
  const ownedPackagePaths: OwnedPackagePath[] = [];
  let prior: string | undefined;
  for (const entry of rawOwnedPackagePaths) {
    if (
      !(
        isPlainFrozenRecord(entry, ["path", "scope"]) &&
        hasDataProperty(entry, "path") &&
        hasDataProperty(entry, "scope")
      )
    )
      return;
    const path = entry["path"];
    const scope = entry["scope"];
    if (
      typeof path !== "string" ||
      typeof scope !== "string" ||
      !isSafePackagePath(path) ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(scope) ||
      (prior !== undefined && prior >= path)
    )
      return;
    ownedPackagePaths.push(Object.freeze({ path, scope }));
    prior = path;
  }
  return Object.freeze({
    maxSubjectLength,
    ownedPackagePaths: Object.freeze(ownedPackagePaths),
  });
}

export function parseDiffSliceInput(
  input: unknown,
): Readonly<{ receipt: unknown; slice: unknown }> | undefined {
  if (
    !(
      isPlainFrozenRecord(input, ["receipt", "slice"]) &&
      hasDataProperty(input, "receipt") &&
      hasDataProperty(input, "slice")
    )
  )
    return;
  return Object.freeze({ receipt: input["receipt"], slice: input["slice"] });
}

export function digestDiffSliceInput(
  input: Readonly<{
    receipt: TaskWorktreeDiffReceipt;
    slice: TaskWorktreeSlice;
  }>,
): TaskWorktreeDigest {
  return digestTaskWorktreeValue({
    receiptDigest: input.receipt.receiptDigest,
    sliceDigest: input.slice.sliceDigest,
  });
}

export function isDigest(input: unknown): input is TaskWorktreeDigest {
  return typeof input === "string" && /^sha256:[a-f0-9]{64}$/u.test(input);
}

function isSafePackagePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  );
}

export function isPlainFrozenRecord(
  input: unknown,
  keys: readonly string[],
): input is Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    !Object.isFrozen(input)
  )
    return false;
  const ownKeys = Reflect.ownKeys(input);
  return (
    ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key))
  );
}

export function hasDataProperty(
  input: Record<string, unknown>,
  key: string,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor;
}
