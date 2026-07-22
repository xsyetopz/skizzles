import { digestValue } from "../../src/digest.ts";
import { createChangeAssuranceExtension } from "../../src/extension.ts";
import type {
  ChangeAssurance,
  ChangeAssuranceAssessmentInput,
  ChangeAssuranceDomain,
  ChangeAssuranceReceipt,
  IndependentSecurityReviewAuthority,
  SecurityMiddleware,
  SecurityPolicyConfig,
  SecurityPolicyLinterAuthority,
} from "../../src/index.ts";
import {
  createChangeAssurance,
  createChangeDeclaration,
  createIndependentSecurityReviewAuthority,
  createSecurityPolicyLinter,
} from "../../src/index.ts";

export const policy: SecurityPolicyConfig = Object.freeze({
  schemaVersion: 1,
  entrypoints: Object.freeze([
    Object.freeze({
      path: "src/entry.ts",
      exportName: "handle",
      requiredMiddleware: Object.freeze([
        "rate-limit",
        "audit-log",
        "sanitize",
      ] satisfies readonly SecurityMiddleware[]),
      requiredSecureImports: Object.freeze(["session-interface"]),
      benchmarkIds: Object.freeze(["http-default"]),
    }),
  ]),
  auditedImports: Object.freeze([
    Object.freeze({
      module: "@app/security-middleware",
      allowedImports: Object.freeze(["rateLimit", "auditLog", "sanitizeInput"]),
      capability: "middleware",
    }),
    Object.freeze({
      module: "@app/session",
      allowedImports: Object.freeze(["sessionBoundary"]),
      capability: "session",
    }),
  ]),
  secureInterfaces: Object.freeze([
    Object.freeze({
      interfaceId: "session-interface",
      module: "@app/session",
      imports: Object.freeze(["sessionBoundary"]),
      capability: "session",
    }),
    Object.freeze({
      interfaceId: "execution-interface",
      module: "@app/secure-execution",
      imports: Object.freeze(["secureSpawn"]),
      capability: "execution",
    }),
    Object.freeze({
      interfaceId: "database-interface",
      module: "@app/secure-database",
      imports: Object.freeze(["secureQuery"]),
      capability: "database",
    }),
    Object.freeze({
      interfaceId: "network-interface",
      module: "@app/secure-network",
      imports: Object.freeze(["secureRequest"]),
      capability: "network",
    }),
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
  sinks: Object.freeze([
    Object.freeze({
      capability: "execution",
      names: Object.freeze(["exec", "spawn"]),
      secureInterfaceIds: Object.freeze(["execution-interface"]),
    }),
    Object.freeze({
      capability: "database",
      names: Object.freeze(["query", "run"]),
      secureInterfaceIds: Object.freeze(["database-interface"]),
    }),
    Object.freeze({
      capability: "network",
      names: Object.freeze(["fetch", "request"]),
      secureInterfaceIds: Object.freeze(["network-interface"]),
    }),
  ]),
});

export const acceptedSource = `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
export function handle(request: unknown) {
  rateLimit(10, 60000);
  auditLog({ requestId: request });
  sanitizeInput(request);
  sessionBoundary(request);
  return request;
}
`;

export interface GateFixture {
  readonly assurance: ChangeAssurance;
  readonly assessment: ChangeAssuranceAssessmentInput;
  readonly assuranceReceipt: ChangeAssuranceReceipt;
  readonly linter: SecurityPolicyLinterAuthority;
  readonly reviewer: IndependentSecurityReviewAuthority;
}

export async function gateFixture(
  sources: Readonly<Record<string, string>>,
  selectedPolicy: SecurityPolicyConfig = policy,
): Promise<GateFixture> {
  const assurance = createAssurance();
  const targets = Object.freeze(
    Object.entries(sources)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, source]) =>
        Object.freeze({
          path,
          operation: "write" as const,
          baselineBytes: Object.freeze([]),
          candidateBytes: Object.freeze([...new TextEncoder().encode(source)]),
        }),
      ),
  );
  const declarationResult = createChangeDeclaration(
    Object.freeze({
      requestDigest: digestValue("security-review-request"),
      repositoryId: "security-review-repository",
      targets: Object.freeze(
        targets.map(({ path, operation }) =>
          Object.freeze({ path, operation }),
        ),
      ),
      plans: Object.freeze({
        "middleware-security": null,
        "migration-configuration-secrets": null,
        performance: null,
        "supply-chain": null,
      }),
    }),
  );
  if (declarationResult.status !== "created")
    throw new Error("security-review declaration fixture rejected");
  const assessment: ChangeAssuranceAssessmentInput = Object.freeze({
    requestDigest: digestValue("security-review-request"),
    repositoryId: "security-review-repository",
    treeDigest: digestValue("security-review-tree"),
    baselineDigest: digestValue("security-review-baseline"),
    declaration: declarationResult.declaration,
    targets,
  });
  const assessed = await assurance.assess(assessment);
  if (assessed.status !== "accepted")
    throw new Error("security-review assurance fixture rejected");
  const linterResult = createSecurityPolicyLinter(
    Object.freeze({
      authorityId: "host/security-policy-linter",
      assurance,
      policy: selectedPolicy,
    }),
  );
  if (linterResult.status !== "created")
    throw new Error("security-review linter fixture rejected");
  const reviewerResult = createIndependentSecurityReviewAuthority(
    Object.freeze({
      authorityId: "host/independent-security-review",
      assurance,
      linter: linterResult.authority,
    }),
  );
  if (reviewerResult.status !== "created")
    throw new Error("security-review authority fixture rejected");
  return Object.freeze({
    assurance,
    assessment,
    assuranceReceipt: assessed.receipt,
    linter: linterResult.authority,
    reviewer: reviewerResult.authority,
  });
}

function createAssurance(): ChangeAssurance {
  const domains: readonly ChangeAssuranceDomain[] = Object.freeze([
    "middleware-security",
    "migration-configuration-secrets",
    "performance",
    "supply-chain",
  ]);
  const extensions = domains.map((domain) => {
    const result = createChangeAssuranceExtension({
      domain,
      id: `fixture-${domain}`,
      version: "1",
      assess: () =>
        Object.freeze({
          status: "accepted" as const,
          evidenceDigest: digestValue({ domain, accepted: true }),
        }),
    });
    if (result.status !== "created")
      throw new Error(`security-review ${domain} extension fixture rejected`);
    return result.extension;
  });
  const created = createChangeAssurance(
    Object.freeze({ extensions: Object.freeze(extensions) }),
  );
  if (created.status !== "created")
    throw new Error("security-review assurance fixture rejected");
  return created.changeAssurance;
}
