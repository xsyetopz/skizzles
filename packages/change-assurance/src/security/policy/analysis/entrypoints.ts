import type {
  ParsedSecuritySource,
  SecurityBenchmark,
  SecurityEntrypointSchema,
  SecurityFinding,
  SecurityPolicyConfig,
} from "../../contract.ts";
import { finding } from "./receipts.ts";
import {
  auditNames,
  hasImport,
  hasMiddleware,
  rateNames,
  sanitizerNames,
} from "./rules.ts";

export function inspectEntrypoint(
  source: ParsedSecuritySource,
  path: string,
  config: SecurityPolicyConfig,
  findings: SecurityFinding[],
): void {
  const entrypoint = config.entrypoints.find(
    (candidate) => candidate.path === path,
  );
  if (entrypoint === undefined) return;
  if (!source.exportedNames.has(entrypoint.exportName)) {
    findings.push(
      finding(
        "ENTRYPOINT_NOT_FOUND",
        path,
        `Schema entrypoint ${entrypoint.exportName} is not exported by the candidate.`,
      ),
    );
  }
  for (const middleware of entrypoint.requiredMiddleware) {
    if (!hasMiddleware(source, middleware)) {
      findings.push(
        finding(
          "MISSING_MIDDLEWARE",
          path,
          `Entrypoint ${entrypoint.exportName} must invoke ${middleware} middleware.`,
        ),
      );
    }
  }
  inspectSecureInterfaces(source, path, entrypoint, config, findings);
  for (const benchmarkId of entrypoint.benchmarkIds) {
    const benchmark = config.benchmarks.find(
      (candidate) => candidate.benchmarkId === benchmarkId,
    );
    if (benchmark !== undefined)
      inspectBenchmark(source, path, benchmark, findings);
  }
}

function inspectSecureInterfaces(
  source: ParsedSecuritySource,
  path: string,
  entrypoint: SecurityEntrypointSchema,
  config: SecurityPolicyConfig,
  findings: SecurityFinding[],
): void {
  for (const requirement of entrypoint.requiredSecureImports) {
    const interfaceRule = config.secureInterfaces.find(
      ({ interfaceId }) => interfaceId === requirement,
    );
    if (interfaceRule === undefined) {
      if (!hasImport(source, requirement, [])) {
        findings.push(
          finding(
            "MISSING_SECURE_INTERFACE",
            path,
            `Required secure import ${requirement} is absent.`,
          ),
        );
      }
      continue;
    }
    if (!hasImport(source, interfaceRule.module, interfaceRule.imports)) {
      findings.push(
        finding(
          "MISSING_SECURE_INTERFACE",
          path,
          `Required secure interface ${interfaceRule.interfaceId} must import ${interfaceRule.imports.join(", ")} from ${interfaceRule.module}.`,
        ),
      );
    }
  }
}

function inspectBenchmark(
  source: ParsedSecuritySource,
  path: string,
  benchmark: SecurityBenchmark,
  findings: SecurityFinding[],
): void {
  const rateCalls = source.callSites.filter(({ name }) => rateNames.has(name));
  if (rateCalls.length === 0) {
    findings.push(
      finding(
        "SECURITY_BENCHMARK_FAILED",
        path,
        `${benchmark.benchmarkId} requires an explicit rate limit.`,
      ),
    );
  }
  const minimumRequests = benchmark.minimumRateLimitRequests;
  const maximumWindow = benchmark.maximumRateLimitWindowMs;
  if (
    (minimumRequests !== undefined || maximumWindow !== undefined) &&
    !rateCalls.every(({ positionalNumericArguments }) => {
      const requests = positionalNumericArguments[0];
      const window = positionalNumericArguments[1];
      return (
        (minimumRequests === undefined ||
          (requests !== null &&
            requests !== undefined &&
            requests >= minimumRequests)) &&
        (maximumWindow === undefined ||
          (window !== null && window !== undefined && window <= maximumWindow))
      );
    })
  ) {
    findings.push(
      finding(
        "SECURITY_BENCHMARK_FAILED",
        path,
        `${benchmark.benchmarkId} rate-limit arguments violate the configured request or window threshold.`,
      ),
    );
  }
  const auditCalls = source.callSites.filter(({ name }) =>
    auditNames.has(name),
  );
  if (auditCalls.length === 0) {
    findings.push(
      finding(
        "SECURITY_BENCHMARK_FAILED",
        path,
        `${benchmark.benchmarkId} requires an audit event.`,
      ),
    );
  }
  if (benchmark.requiredAuditFields !== undefined) {
    const fields = new Set(
      auditCalls.flatMap(({ stringArguments, objectPropertyNames }) => [
        ...stringArguments,
        ...objectPropertyNames,
      ]),
    );
    for (const field of benchmark.requiredAuditFields) {
      if (!fields.has(field))
        findings.push(
          finding(
            "SECURITY_BENCHMARK_FAILED",
            path,
            `${benchmark.benchmarkId} audit output omits ${field}.`,
          ),
        );
    }
  }
  const sanitizers = source.callSites.filter(({ name }) =>
    sanitizerNames.has(name),
  );
  if (sanitizers.length === 0) {
    findings.push(
      finding(
        "SECURITY_BENCHMARK_FAILED",
        path,
        `${benchmark.benchmarkId} requires input sanitization.`,
      ),
    );
  }
  if (
    benchmark.sanitizerNames !== undefined &&
    !sanitizers.some(
      ({ name }) => benchmark.sanitizerNames?.includes(name) === true,
    )
  ) {
    findings.push(
      finding(
        "SECURITY_BENCHMARK_FAILED",
        path,
        `${benchmark.benchmarkId} uses an unconfigured sanitizer.`,
      ),
    );
  }
  if (benchmark.maximumRequestBytes !== undefined) {
    const sizeCalls = source.callSites.filter(({ name }) =>
      ["bodyLimit", "requestSizeLimit", "maxRequestBytes"].includes(name),
    );
    const maximumRequestBytes = benchmark.maximumRequestBytes;
    if (
      maximumRequestBytes !== undefined &&
      (sizeCalls.length === 0 ||
        !sizeCalls.every(({ positionalNumericArguments }) => {
          const limit = positionalNumericArguments[0];
          return (
            limit !== null &&
            limit !== undefined &&
            limit <= maximumRequestBytes
          );
        }))
    ) {
      findings.push(
        finding(
          "SECURITY_BENCHMARK_FAILED",
          path,
          `${benchmark.benchmarkId} permits oversized requests.`,
        ),
      );
    }
  }
}
