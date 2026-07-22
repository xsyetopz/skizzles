import { types } from "node:util";
import type { ConfigurationWriteReceipt } from "../../configuration/contracts.ts";
import {
  isConfigurationWriteAuthorized,
  isConfigurationWriteReceipt,
} from "../../configuration/registry.ts";
import type { CandidateBytes, SecretScanInput } from "./contract.ts";

export function dataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor !== undefined && "value" in descriptor)
    return descriptor.value;
}

export function pathIsUnsafe(path: string): boolean {
  return (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === "")
  );
}

export function envPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return basename === ".env" || basename.startsWith(".env.");
}

function validCandidate(value: unknown): value is CandidateBytes {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return false;
  const path = dataValue(value, "path");
  const bytes = dataValue(value, "bytes");
  return typeof path === "string" && bytes instanceof Uint8Array;
}

export function parseScanInput(input: unknown): SecretScanInput | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input)
  )
    return;
  const candidates = dataValue(input, "candidates");
  const configurationPaths = dataValue(input, "configurationPaths");
  const authorizedWrites = dataValue(input, "authorizedConfigurationWrites");
  if (!(Array.isArray(candidates) && candidates.every(validCandidate))) return;
  if (
    configurationPaths !== undefined &&
    !(
      Array.isArray(configurationPaths) &&
      configurationPaths.every(
        (path) => typeof path === "string" && !path.includes("\0"),
      )
    )
  )
    return;
  if (
    authorizedWrites !== undefined &&
    !(
      Array.isArray(authorizedWrites) &&
      authorizedWrites.every((receipt) => isConfigurationWriteReceipt(receipt))
    )
  )
    return;
  const parsedCandidates: CandidateBytes[] = [];
  for (const candidate of candidates) {
    const path = dataValue(candidate, "path");
    const rawBytes = dataValue(candidate, "bytes");
    if (typeof path !== "string" || !(rawBytes instanceof Uint8Array)) return;
    parsedCandidates.push({ path, bytes: new Uint8Array(rawBytes) });
  }
  return {
    candidates: Object.freeze(parsedCandidates),
    ...(configurationPaths === undefined
      ? {}
      : { configurationPaths: Object.freeze([...configurationPaths]) }),
    ...(authorizedWrites === undefined
      ? {}
      : {
          authorizedConfigurationWrites: Object.freeze([...authorizedWrites]),
        }),
  };
}

export function authorizedFor(
  path: string,
  bytes: Uint8Array,
  receipts: readonly ConfigurationWriteReceipt[],
): boolean {
  return receipts.some((receipt) =>
    isConfigurationWriteAuthorized(receipt, { path, bytes }),
  );
}
