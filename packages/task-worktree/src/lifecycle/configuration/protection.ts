import { types } from "node:util";
import type { TaskWorktreeConfig } from "../../contract.ts";
import { isSafeRelativePath } from "../../policy/value.ts";
import type { TaskWorktreeProtectedPathAuthorizationRequest } from "../../protection/public-contract.ts";

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;

export function parseProtectedPaths(
  value: unknown,
): TaskWorktreeConfig["protectedPaths"] | undefined {
  const record = exactRecord(value, [
    "authorize",
    "policyId",
    "specificationRoots",
    "testRoots",
  ]);
  const policyId = record?.get("policyId");
  const authorize = record?.get("authorize");
  const testRoots = parseCanonicalRoots(record?.get("testRoots"));
  const specificationRoots = parseCanonicalRoots(
    record?.get("specificationRoots"),
  );
  if (
    record === undefined ||
    !Object.isFrozen(value) ||
    !identity(policyId) ||
    typeof authorize !== "function" ||
    testRoots === undefined ||
    specificationRoots === undefined ||
    specificationRoots.length === 0 ||
    [...testRoots, ...specificationRoots].some((root, index, roots) =>
      roots.some(
        (candidate, candidateIndex) =>
          index !== candidateIndex && rootsOverlap(root, candidate),
      ),
    )
  )
    return;
  return Object.freeze({
    policyId,
    testRoots,
    specificationRoots,
    authorize: async (request: TaskWorktreeProtectedPathAuthorizationRequest) =>
      await Reflect.apply(authorize, undefined, [request]),
  });
}

function parseCanonicalRoots(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !Object.isFrozen(value) || value.length > 64)
    return;
  const roots: string[] = [];
  const aliases = new Set<string>();
  for (const root of value) {
    if (
      typeof root !== "string" ||
      !isSafeRelativePath(root) ||
      root !== root.normalize("NFC") ||
      aliases.has(root.toLowerCase())
    )
      return;
    aliases.add(root.toLowerCase());
    roots.push(root);
  }
  return Object.freeze(roots.sort((left, right) => (left < right ? -1 : 1)));
}

function rootsOverlap(left: string, right: string): boolean {
  const canonicalLeft = left.toLowerCase();
  const canonicalRight = right.toLowerCase();
  return (
    canonicalLeft === canonicalRight ||
    canonicalLeft.startsWith(`${canonicalRight}/`) ||
    canonicalRight.startsWith(`${canonicalLeft}/`)
  );
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

function identity(value: unknown): value is string {
  return typeof value === "string" && identityPattern.test(value);
}
