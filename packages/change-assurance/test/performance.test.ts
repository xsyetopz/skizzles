// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import { digestBytes, digestValue } from "../src/digest.ts";
import { invokeExtension } from "../src/extension.ts";
import {
  assessPerformance,
  createPerformanceAssuranceExtension,
  createPerformanceBenchmarkAuthority,
  isPerformanceBenchmarkAuthority,
} from "../src/performance/authority.ts";
import type {
  PerformanceBenchmarkAuthority,
  PerformanceBenchmarkInvocation,
} from "../src/performance/contract.ts";
import { createPerformancePlan } from "../src/performance/input.ts";

const encoder = new TextEncoder();

describe("performance assurance", () => {
  it("times the authentic host runner over fixed increasing sizes", async () => {
    const bytes = Object.freeze([
      ...encoder.encode("export const value = 1;\n"),
    ]);
    const candidateDigest = digestBytes(Uint8Array.from(bytes));
    let calls = 0;
    const authority = createAuthority((invocation) => {
      calls += 1;
      expect(invocation.candidateDigest).toBe(candidateDigest);
      expect(invocation.candidateBytes).toEqual(bytes);
    });
    const result = await assessPerformance(
      authority,
      assessment(candidateDigest, bytes),
    );
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("benchmark did not pass");
    expect(calls).toBe(3);
    expect(
      result.receipt.candidates[0]?.samples.map(({ inputSize }) => inputSize),
    ).toEqual([1, 2, 4]);
    expect(Object.isFrozen(result.receipt)).toBe(true);
  });

  it("reuses the authenticated receipt on exact replay", async () => {
    const bytes = Object.freeze([...encoder.encode("candidate")]);
    const digest = digestBytes(Uint8Array.from(bytes));
    let calls = 0;
    const authority = createAuthority(() => {
      calls += 1;
    });
    const input = assessment(digest, bytes);
    await expect(assessPerformance(authority, input)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(assessPerformance(authority, input)).resolves.toMatchObject({
      status: "accepted",
    });
    expect(calls).toBe(3);
  });

  it("rejects forged authorities and caller-supplied measurements", async () => {
    const fake = Object.freeze({
      kind: "performance-benchmark-authority",
      authorityId: "fake",
    });
    expect(isPerformanceBenchmarkAuthority(fake)).toBe(false);
    const bytes = Object.freeze([...encoder.encode("candidate")]);
    const digest = digestBytes(Uint8Array.from(bytes));
    const authority = createAuthority(() => undefined);
    await expect(
      assessPerformance(fake, assessment(digest, bytes)),
    ).resolves.toEqual({
      status: "rejected",
      code: "UNAUTHENTIC_PERFORMANCE_AUTHORITY",
    });
    await expect(
      assessPerformance(authority, {
        ...assessment(digest, bytes),
        samples: Object.freeze([]),
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "INVALID_PERFORMANCE_INPUT",
    });
  });

  it("rejects candidate digest drift before invoking the runner", async () => {
    const bytes = Object.freeze([...encoder.encode("candidate")]);
    const authority = createAuthority(() => {
      throw new Error("runner must not execute");
    });
    const wrong = digestValue("different");
    await expect(
      assessPerformance(authority, assessment(wrong, bytes, wrong)),
    ).resolves.toEqual({
      status: "rejected",
      code: "PERFORMANCE_TARGET_BINDING_REJECTED",
    });
  });

  it("enforces the configured regression baseline", async () => {
    const bytes = Object.freeze([...encoder.encode("candidate")]);
    const digest = digestBytes(Uint8Array.from(bytes));
    const authority = createAuthority(() => undefined, 0.000001);
    await expect(
      assessPerformance(authority, assessment(digest, bytes)),
    ).resolves.toEqual({
      status: "rejected",
      code: "PERFORMANCE_REGRESSION_REJECTED",
    });
  });

  it("passes the authentic benchmark through the generic extension boundary", async () => {
    const bytes = Object.freeze([...encoder.encode("candidate")]);
    const digest = digestBytes(Uint8Array.from(bytes));
    const authority = createAuthority(() => undefined);
    const planResult = createPerformancePlan(
      Object.freeze({
        schemaVersion: 1,
        claim: Object.freeze({ notation: "O(n)", inputMetric: "items" }),
        candidates: Object.freeze([
          Object.freeze({ path: "src/value.ts", candidateDigest: digest }),
        ]),
      }),
    );
    if (planResult.status !== "created") throw new Error("plan failed");
    const extension = createPerformanceAssuranceExtension(
      Object.freeze({
        id: "performance",
        version: "1",
        authority,
      }),
    );
    if (extension.status !== "created") throw new Error("extension failed");
    const result = await invokeExtension(
      extension.extension,
      Object.freeze({
        requestDigest: digestValue("request"),
        repositoryId: "repo-a",
        treeDigest: digestValue("tree"),
        baselineDigest: digestValue("baseline"),
        declarationDigest: digestValue("declaration"),
        domain: "performance",
        plan: planResult.plan,
        targets: Object.freeze([
          Object.freeze({
            path: "src/value.ts",
            operation: "write",
            baselineBytes: Object.freeze([...encoder.encode("baseline")]),
            candidateBytes: bytes,
          }),
        ]),
      }),
    );
    expect(result.status).toBe("accepted");
  });
});

function createAuthority(
  runCandidate: (input: PerformanceBenchmarkInvocation) => unknown,
  maximumMedianMilliseconds = 1000,
): PerformanceBenchmarkAuthority {
  const registration = createPerformanceBenchmarkAuthority(
    Object.freeze({
      authorityId: "host-benchmark",
      inputSizes: Object.freeze([1, 2, 4]),
      samplesPerSize: 1,
      maximumCoefficientOfVariation: 10,
      maximumComplexityExponent: 8,
      regressionBaseline: Object.freeze({
        baselineId: "baseline-1",
        points: Object.freeze([
          Object.freeze({ inputSize: 1, maximumMedianMilliseconds }),
          Object.freeze({ inputSize: 2, maximumMedianMilliseconds }),
          Object.freeze({ inputSize: 4, maximumMedianMilliseconds }),
        ]),
        maximumSlowdownRatio: 10,
      }),
      runCandidate: (input: PerformanceBenchmarkInvocation) =>
        runCandidate(input),
    }),
  );
  if (registration.status !== "created")
    throw new Error("authority registration failed");
  return registration.authority;
}

function assessment(
  planDigest: string,
  bytes: readonly number[],
  candidateDigest = planDigest,
): Readonly<Record<string, unknown>> {
  const plan = createPerformancePlan(
    Object.freeze({
      schemaVersion: 1,
      claim: Object.freeze({ notation: "O(n)", inputMetric: "items" }),
      candidates: Object.freeze([
        Object.freeze({ path: "src/value.ts", candidateDigest }),
      ]),
    }),
  );
  if (plan.status !== "created") throw new Error("plan creation failed");
  return Object.freeze({
    requestDigest: digestValue("request"),
    repositoryId: "repo-a",
    plan: plan.plan,
    candidates: Object.freeze([
      Object.freeze({
        path: "src/value.ts",
        candidateBytes: Object.freeze([...bytes]),
      }),
    ]),
  });
}
