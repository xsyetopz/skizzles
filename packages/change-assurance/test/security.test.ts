// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import {
  analyzeSecurityCandidates,
  assessSecurityExtension,
  createSecurityAssuranceExtension,
  createSessionBoundaryRuntime,
  type SecurityAssessment,
  type SecurityMiddleware,
  type SecurityPolicyConfig,
  type SessionProbeRequest,
} from "../src/security/index.ts";

const requiredMiddleware: readonly SecurityMiddleware[] = Object.freeze([
  "rate-limit",
  "audit-log",
  "sanitize",
]);

const policy: SecurityPolicyConfig = Object.freeze({
  schemaVersion: 1,
  entrypoints: Object.freeze([
    Object.freeze({
      path: "src/entry.ts",
      exportName: "handle",
      requiredMiddleware,
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
      names: Object.freeze(["exec"]),
      secureInterfaceIds: Object.freeze(["session-interface"]),
    }),
    Object.freeze({
      capability: "database",
      names: Object.freeze(["query"]),
      secureInterfaceIds: Object.freeze(["session-interface"]),
    }),
    Object.freeze({
      capability: "network",
      names: Object.freeze(["fetch"]),
      secureInterfaceIds: Object.freeze(["session-interface"]),
    }),
  ]),
});

function candidate(
  path: string,
  source: string,
): SecurityAssessment["targets"][number] {
  return Object.freeze({
    path,
    operation: "write",
    baselineBytes: Object.freeze([]),
    candidateBytes: Object.freeze([...new TextEncoder().encode(source)]),
  });
}

function assessment(
  targets: readonly SecurityAssessment["targets"][number][],
): SecurityAssessment {
  return Object.freeze({
    requestDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repositoryId: "repo",
    treeDigest:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    baselineDigest:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    declarationDigest:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    domain: "middleware-security",
    plan: null,
    targets,
  });
}

const acceptedSource = `
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

describe("middleware security AST authority", () => {
  it("accepts schema-compliant middleware and secure imports", async () => {
    const result = await analyzeSecurityCandidates(
      assessment([candidate("src/entry.ts", acceptedSource)]),
      policy,
    );
    expect(result.status).toBe("accepted");
    expect(result.findingCount).toBe(0);
    expect(result.evidenceDigest.startsWith("sha256:")).toBe(true);
  });

  it("binds benchmark thresholds to their declared argument positions", async () => {
    const swapped = acceptedSource.replace(
      "rateLimit(10, 60000)",
      "rateLimit(1, 999999)",
    );
    const result = await analyzeSecurityCandidates(
      assessment([candidate("src/entry.ts", swapped)]),
      policy,
    );
    expect(result.status).toBe("rejected");
    expect(result.findings.map(({ code }) => code)).toContain(
      "SECURITY_BENCHMARK_FAILED",
    );
  });

  it("requires an explicit positional request-size limit when configured", async () => {
    const boundedPolicy: SecurityPolicyConfig = Object.freeze({
      ...policy,
      benchmarks: Object.freeze([
        Object.freeze({
          benchmarkId: "http-default",
          minimumRateLimitRequests: 10,
          maximumRateLimitWindowMs: 60_000,
          maximumRequestBytes: 1024,
          requiredAuditFields: Object.freeze(["requestId"]),
          sanitizerNames: Object.freeze(["sanitizeInput"]),
        }),
      ]),
    });
    const result = await analyzeSecurityCandidates(
      assessment([candidate("src/entry.ts", acceptedSource)]),
      boundedPolicy,
    );
    expect(result.status).toBe("rejected");
    expect(result.findings.map(({ code }) => code)).toContain(
      "SECURITY_BENCHMARK_FAILED",
    );
  });

  it("rejects missing middleware, unaudited crypto, and sink concatenation", async () => {
    const source = `
import { createHash } from "node:crypto";
import { query } from "pg";
export function handle(input: string) {
  query("select * from users where id = " + input);
  return createHash("sha256");
}
`;
    const result = await analyzeSecurityCandidates(
      assessment([candidate("src/entry.ts", source)]),
      policy,
    );
    expect(result.status).toBe("rejected");
    expect(result.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "MISSING_MIDDLEWARE",
        "CUSTOM_CRYPTOGRAPHY",
        "RAW_DATABASE_PRIMITIVE",
        "UNSAFE_DATABASE_CONCATENATION",
      ]),
    );
  });

  it("uses the authentic extension boundary rather than a copied method", async () => {
    expect(
      createSecurityAssuranceExtension({
        id: "security",
        version: "1",
        policy,
      }),
    ).toEqual({ status: "rejected", code: "INVALID_EXTENSION_CONFIG" });
    const runtime = acceptedSessionRuntime();
    const created = createSecurityAssuranceExtension({
      id: "security",
      version: "1",
      policy,
      session: {
        config: {
          requiredRole: "admin",
          maximumSessionAgeMs: 60_000,
          refreshWindowMs: 10_000,
        },
        runtime,
      },
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      return;
    }
    expect(Object.isFrozen(created.extension)).toBe(true);
    const copied = { ...created.extension };
    expect(Reflect.get(copied, "assess")).toBeUndefined();
  });

  it("fails closed on proxy and accessor configuration inputs", () => {
    const accessor: object = Object.create(null);
    Object.defineProperty(accessor, "id", {
      get: () => {
        throw new Error("getter executed");
      },
      enumerable: true,
    });
    Object.defineProperty(accessor, "version", {
      value: "1",
      enumerable: true,
    });
    Object.defineProperty(accessor, "policy", {
      value: policy,
      enumerable: true,
    });
    expect(createSecurityAssuranceExtension(accessor).status).toBe("rejected");
    const proxy = new Proxy(
      { id: "security", version: "1", policy },
      {
        get: () => {
          throw new Error("proxy trap executed");
        },
      },
    );
    expect(createSecurityAssuranceExtension(proxy).status).toBe("rejected");
  });

  it("composes the session authority into extension assessment", async () => {
    const requests: SessionProbeRequest[] = [];
    const createdRuntime = createSessionBoundaryRuntime(
      async (request: SessionProbeRequest) => {
        requests.push(request);
        const { operation } = request;
        if (operation === "expiry") {
          return { decision: "expired", state: "expired" };
        }
        if (operation === "refresh") {
          return { decision: "allow", state: "refreshed" };
        }
        if (operation === "logout") {
          return { decision: "allow", state: "logged-out" };
        }
        if (operation === "role") {
          return { decision: "allow", state: "active", role: "admin" };
        }
        if (operation === "unauthorized") {
          return { decision: "deny", state: "absent" };
        }
        return { decision: "unavailable", state: "absent" };
      },
    );
    expect(createdRuntime.status).toBe("created");
    if (createdRuntime.status !== "created") {
      return;
    }
    const result = await assessSecurityExtension(
      assessment([candidate("src/entry.ts", acceptedSource)]),
      {
        id: "security",
        version: "1",
        policy,
        session: {
          config: {
            requiredRole: "admin",
            maximumSessionAgeMs: 60_000,
            refreshWindowMs: 10_000,
          },
          runtime: createdRuntime.runtime,
        },
      },
    );
    expect(result.status).toBe("accepted");
    expect(
      requests.find(({ operation }) => operation === "expiry"),
    ).toMatchObject({ sessionAgeMs: 60_000, remainingLifetimeMs: 0 });
    expect(
      requests.find(({ operation }) => operation === "refresh"),
    ).toMatchObject({ sessionAgeMs: 50_000, remainingLifetimeMs: 10_000 });
    const differentTiming = await assessSecurityExtension(
      assessment([candidate("src/entry.ts", acceptedSource)]),
      {
        id: "security",
        version: "1",
        policy,
        session: {
          config: {
            requiredRole: "admin",
            maximumSessionAgeMs: 120_000,
            refreshWindowMs: 20_000,
          },
          runtime: createdRuntime.runtime,
        },
      },
    );
    expect(differentTiming.status).toBe("accepted");
    if (result.status === "accepted" && differentTiming.status === "accepted") {
      expect(differentTiming.evidenceDigest).not.toBe(result.evidenceDigest);
    }
  });
});

function acceptedSessionRuntime() {
  const created = createSessionBoundaryRuntime(
    async ({ operation }: SessionProbeRequest) => {
      if (operation === "expiry") {
        return { decision: "expired", state: "expired" };
      }
      if (operation === "refresh") {
        return { decision: "allow", state: "refreshed" };
      }
      if (operation === "logout") {
        return { decision: "allow", state: "logged-out" };
      }
      if (operation === "role") {
        return { decision: "allow", state: "active", role: "admin" };
      }
      if (operation === "unauthorized") {
        return { decision: "deny", state: "absent" };
      }
      return { decision: "unavailable", state: "absent" };
    },
  );
  if (created.status !== "created") {
    throw new Error("session runtime fixture rejected");
  }
  return created.runtime;
}
