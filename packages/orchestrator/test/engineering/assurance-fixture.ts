import {
  type ChangeAssurance,
  type ChangeDeclaration,
  createChangeAssurance,
  createChangeDeclaration,
  createIndependentSecurityReviewAuthority,
  createLicensePolicyAuthority,
  createMigrationConfigurationSecretsExtension,
  createPerformanceAssuranceExtension,
  createPerformanceBenchmarkAuthority,
  createRegistryMetadataAuthority,
  createSecurityAssuranceExtension,
  createSecurityPolicyLinter,
  createSessionBoundaryRuntime,
  createSupplyChainAssuranceExtension,
  createSupplyChainAuthority,
  createVulnerabilityAuthority,
  digestMetadata,
  type SessionProbeRequest,
} from "@skizzles/change-assurance";
import { digestValue } from "../../src/digest.ts";

const packageDigest = digestValue("safe-package");
const metadataMaterial = Object.freeze({
  registryId: "fixture-registry",
  registryUrl: "https://registry.invalid",
  name: "safe-package",
  version: "1.0.0",
  packageDigest,
  licenseExpression: "MIT",
  dependencies: Object.freeze([]),
});
const metadata = Object.freeze({
  ...metadataMaterial,
  metadataDigest: digestMetadata(metadataMaterial),
});

export function createTestChangeAssurance(): ChangeAssurance {
  const sessionRuntime = createSessionBoundaryRuntime(
    async ({ operation }: SessionProbeRequest) => {
      if (operation === "expiry") {
        return Object.freeze({ decision: "expired", state: "expired" });
      }
      if (operation === "refresh") {
        return Object.freeze({ decision: "allow", state: "refreshed" });
      }
      if (operation === "logout") {
        return Object.freeze({ decision: "allow", state: "logged-out" });
      }
      if (operation === "role") {
        return Object.freeze({
          decision: "allow",
          state: "active",
          role: "maintainer",
        });
      }
      if (operation === "unauthorized") {
        return Object.freeze({ decision: "deny", state: "absent" });
      }
      return Object.freeze({ decision: "unavailable", state: "absent" });
    },
  );
  if (sessionRuntime.status !== "created") {
    throw new Error("session runtime fixture rejected");
  }
  const security = createSecurityAssuranceExtension(
    Object.freeze({
      id: "fixture-security",
      version: "1.0.0",
      policy: securityPolicy(),
      session: Object.freeze({
        config: Object.freeze({
          requiredRole: "maintainer",
          maximumSessionAgeMs: 60_000,
          refreshWindowMs: 10_000,
        }),
        runtime: sessionRuntime.runtime,
      }),
    }),
  );
  const migration = createMigrationConfigurationSecretsExtension(
    Object.freeze({
      id: "fixture-migration",
      version: "1.0.0",
      configurationPaths: Object.freeze([]),
    }),
  );
  const performanceAuthority = createPerformanceBenchmarkAuthority(
    Object.freeze({
      authorityId: "fixture-performance",
      inputSizes: Object.freeze([1, 2, 4]),
      samplesPerSize: 1,
      maximumCoefficientOfVariation: 10,
      maximumComplexityExponent: 8,
      regressionBaseline: Object.freeze({
        baselineId: "fixture-baseline",
        points: Object.freeze(
          [1, 2, 4].map((inputSize) =>
            Object.freeze({ inputSize, maximumMedianMilliseconds: 1000 }),
          ),
        ),
        maximumSlowdownRatio: 10,
      }),
      runCandidate: () => undefined,
    }),
  );
  if (performanceAuthority.status !== "created") {
    throw new Error("performance authority fixture rejected");
  }
  const performance = createPerformanceAssuranceExtension(
    Object.freeze({
      id: "fixture-performance-extension",
      version: "1.0.0",
      authority: performanceAuthority.authority,
    }),
  );
  const registry = createRegistryMetadataAuthority(
    Object.freeze({
      authorityId: "fixture-registry",
      registryId: "fixture-registry",
      registryUrl: "https://registry.invalid",
      lookup: () => metadata,
    }),
  );
  const vulnerabilities = createVulnerabilityAuthority(
    Object.freeze({
      authorityId: "fixture-vulnerabilities",
      databaseId: "fixture-db",
      databaseVersion: "1",
      lookup: () => {
        const material = Object.freeze({
          databaseId: "fixture-db",
          databaseVersion: "1",
          name: metadata.name,
          version: metadata.version,
          metadataDigest: metadata.metadataDigest,
          findings: Object.freeze([]),
        });
        return Object.freeze({
          ...material,
          reportDigest: digestValue(material),
        });
      },
    }),
  );
  const licenses = createLicensePolicyAuthority(
    Object.freeze({
      policyId: "fixture-licenses",
      allowedLicenseIds: Object.freeze(["MIT"]),
    }),
  );
  if (
    registry.status !== "created" ||
    vulnerabilities.status !== "created" ||
    licenses.status !== "created"
  ) {
    throw new Error("supply authority fixture rejected");
  }
  const supplyAuthority = createSupplyChainAuthority(
    Object.freeze({
      authorityId: "fixture-supply",
      whitelist: Object.freeze([
        Object.freeze({
          name: metadata.name,
          version: metadata.version,
          metadataDigest: metadata.metadataDigest,
          packageDigest: metadata.packageDigest,
        }),
      ]),
      registry: registry.authority,
      vulnerabilities: vulnerabilities.authority,
      licenses: licenses.authority,
    }),
  );
  if (supplyAuthority.status !== "created") {
    throw new Error("supply composition fixture rejected");
  }
  const supply = createSupplyChainAssuranceExtension(
    Object.freeze({
      id: "fixture-supply-extension",
      version: "1.0.0",
      authority: supplyAuthority.authority,
    }),
  );
  const extensions = [security, migration, performance, supply].map(
    (created, index) => {
      if (created.status !== "created") {
        throw new Error(
          `assurance extension ${index} fixture rejected: ${JSON.stringify(created)}`,
        );
      }
      return created.extension;
    },
  );
  const assurance = createChangeAssurance(
    Object.freeze({ extensions: Object.freeze(extensions) }),
  );
  if (assurance.status !== "created") {
    throw new Error("change assurance fixture rejected");
  }
  return assurance.changeAssurance;
}

export function createTestSecurityReview(assurance: ChangeAssurance) {
  const linter = createSecurityPolicyLinter(
    Object.freeze({
      authorityId: "fixture-security-linter",
      assurance,
      policy: securityPolicy(),
    }),
  );
  if (linter.status !== "created") {
    throw new Error("security linter fixture rejected");
  }
  const reviewer = createIndependentSecurityReviewAuthority(
    Object.freeze({
      authorityId: "fixture-security-reviewer",
      assurance,
      linter: linter.authority,
    }),
  );
  if (reviewer.status !== "created") {
    throw new Error("security reviewer fixture rejected");
  }
  return Object.freeze({
    linter: linter.authority,
    reviewer: reviewer.authority,
  });
}

export function createTestChangeDeclaration(
  input: Readonly<{
    requestDigest: `sha256:${string}`;
    repositoryId: string;
    targets: readonly Readonly<{
      path: string;
      candidateDigest: string;
    }>[];
  }>,
): ChangeDeclaration {
  const declaration = createChangeDeclaration(
    Object.freeze({
      requestDigest: input.requestDigest,
      repositoryId: input.repositoryId,
      targets: Object.freeze(
        input.targets.map(({ path }) =>
          Object.freeze({ path, operation: "write" as const }),
        ),
      ),
      plans: Object.freeze({
        "middleware-security": Object.freeze({ schemaVersion: 1 }),
        "migration-configuration-secrets": Object.freeze({
          migrations: Object.freeze([]),
        }),
        performance: Object.freeze({
          schemaVersion: 1,
          claim: Object.freeze({ notation: "O(n)", inputMetric: "items" }),
          candidates: Object.freeze(
            input.targets.map(({ path, candidateDigest }) =>
              Object.freeze({ path, candidateDigest }),
            ),
          ),
        }),
        "supply-chain": Object.freeze({
          schemaVersion: 1,
          changes: Object.freeze([
            Object.freeze({
              name: metadata.name,
              version: metadata.version,
              operation: "add",
            }),
          ]),
        }),
      }),
    }),
  );
  if (declaration.status !== "created") {
    throw new Error("change declaration fixture rejected");
  }
  return declaration.declaration;
}

function securityPolicy() {
  return Object.freeze({
    schemaVersion: 1 as const,
    entrypoints: Object.freeze([
      Object.freeze({
        path: "src/entry.ts",
        exportName: "handle",
        requiredMiddleware: Object.freeze([
          "rate-limit",
          "audit-log",
          "sanitize",
        ]),
        requiredSecureImports: Object.freeze(["session-interface"]),
        benchmarkIds: Object.freeze(["http-default"]),
      }),
    ]),
    auditedImports: Object.freeze([
      Object.freeze({
        module: "@app/security-middleware",
        allowedImports: Object.freeze([
          "rateLimit",
          "auditLog",
          "sanitizeInput",
        ]),
        capability: "middleware" as const,
      }),
      Object.freeze({
        module: "@app/session",
        allowedImports: Object.freeze(["sessionBoundary"]),
        capability: "session" as const,
      }),
    ]),
    secureInterfaces: Object.freeze([
      Object.freeze({
        interfaceId: "session-interface",
        module: "@app/session",
        imports: Object.freeze(["sessionBoundary"]),
        capability: "session" as const,
      }),
      ...(["execution", "database", "network"] as const).map((capability) =>
        Object.freeze({
          interfaceId: `${capability}-interface`,
          module: `@app/${capability}`,
          imports: Object.freeze([`${capability}Boundary`]),
          capability,
        }),
      ),
    ]),
    benchmarks: Object.freeze([
      Object.freeze({
        benchmarkId: "http-default",
        minimumRateLimitRequests: 10,
        maximumRateLimitWindowMs: 60_000,
        requiredAuditFields: Object.freeze(["requestId"]),
        sanitizerNames: Object.freeze(["sanitizeInput"]),
      }),
    ]),
    sinks: Object.freeze(
      (["execution", "database", "network"] as const).map((capability) =>
        Object.freeze({
          capability,
          names: Object.freeze([
            capability === "execution"
              ? "exec"
              : capability === "database"
                ? "query"
                : "fetch",
          ]),
          secureInterfaceIds: Object.freeze([`${capability}-interface`]),
        }),
      ),
    ),
  });
}
