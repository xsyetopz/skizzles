import type { SecurityPolicyConfig } from "../contract.ts";
import { parseBenchmarks } from "./config/benchmarks.ts";
import {
  parseAuditedImports,
  parseEntrypoints,
  parseSecureInterfaces,
} from "./config/schema.ts";
import { parseSinks } from "./config/sinks.ts";
import { exactRecord } from "./config/values.ts";

export function parseSecurityPolicyConfig(
  input: unknown,
): SecurityPolicyConfig | undefined {
  const root = exactRecord(input, [
    "schemaVersion",
    "entrypoints",
    "auditedImports",
    "secureInterfaces",
    "benchmarks",
    "sinks",
  ]);
  if (root === undefined || root["schemaVersion"] !== 1) return;
  const entrypoints = parseEntrypoints(root["entrypoints"]);
  const auditedImports = parseAuditedImports(root["auditedImports"]);
  const secureInterfaces = parseSecureInterfaces(root["secureInterfaces"]);
  const benchmarks = parseBenchmarks(root["benchmarks"]);
  const sinks = parseSinks(root["sinks"]);
  if (
    entrypoints === undefined ||
    auditedImports === undefined ||
    secureInterfaces === undefined ||
    benchmarks === undefined ||
    sinks === undefined
  )
    return;
  const benchmarkIds = new Set(
    benchmarks.map(({ benchmarkId }) => benchmarkId),
  );
  const interfaceIds = new Set(
    secureInterfaces.map(({ interfaceId }) => interfaceId),
  );
  if (
    entrypoints.some(
      (entrypoint) =>
        entrypoint.benchmarkIds.some((id) => !benchmarkIds.has(id)) ||
        entrypoint.requiredSecureImports.some(
          (id) =>
            !(
              interfaceIds.has(id) ||
              auditedImports.some(({ module }) => module === id)
            ),
        ),
    )
  )
    return;
  return Object.freeze({
    schemaVersion: 1,
    entrypoints,
    auditedImports,
    secureInterfaces,
    benchmarks,
    sinks,
  });
}
