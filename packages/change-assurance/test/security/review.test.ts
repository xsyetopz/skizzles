// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import {
  createIndependentSecurityReviewAuthority,
  createSecurityPolicyLinter,
  isIndependentSecurityReviewAuthority,
  isSecurityPolicyLinter,
  isSecurityPolicyLintReceipt,
  isSecurityReviewReceipt,
} from "../../src/index.ts";
import { acceptedSource, gateFixture, policy } from "./fixture.ts";

describe("independent security review gate", () => {
  it("issues and revalidates authentic receipts over exact assurance bytes", async () => {
    const fixture = await gateFixture({ "src/entry.ts": acceptedSource });
    const lint = await fixture.linter.lint(lintInput(fixture));
    expect(lint.status).toBe("completed");
    if (lint.status !== "completed") return;
    expect(isSecurityPolicyLintReceipt(lint.receipt)).toBe(true);
    expect(lint.receipt.candidateManifestDigest).toBe(
      fixture.assuranceReceipt.candidateManifestDigest,
    );
    expect(
      fixture.linter.verify(
        Object.freeze({ ...lintInput(fixture), receipt: lint.receipt }),
      ),
    ).toBe(true);
    const reviewed = fixture.reviewer.review(
      Object.freeze({ ...lintInput(fixture), lintReceipt: lint.receipt }),
    );
    expect(reviewed.status).toBe("accepted");
    if (reviewed.status !== "accepted") return;
    expect(isSecurityReviewReceipt(reviewed.receipt)).toBe(true);
    expect(reviewed.receipt.candidateManifestDigest).toBe(
      lint.receipt.candidateManifestDigest,
    );
    expect(
      fixture.reviewer.verify(
        Object.freeze({
          ...lintInput(fixture),
          lintReceipt: lint.receipt,
          receipt: reviewed.receipt,
        }),
      ),
    ).toBe(true);
    expect(reviewed.receipt.assuranceReceiptDigest).toBe(
      fixture.assuranceReceipt.receiptDigest,
    );
  });

  it("halts on every known high or critical finding without a waiver surface", async () => {
    const fixture = await gateFixture({
      "src/entry.ts": `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
export function handle(request: unknown) {
  if (request) sanitizeInput(request);
  rateLimit(10, 60000);
  auditLog({ requestId: request });
  sessionBoundary(request);
  return request;
}
`,
    });
    const lint = await fixture.linter.lint(lintInput(fixture));
    expect(lint.status).toBe("completed");
    if (lint.status !== "completed") return;
    expect(lint.receipt.findings.length).toBeGreaterThan(0);
    const reviewed = fixture.reviewer.review(
      Object.freeze({ ...lintInput(fixture), lintReceipt: lint.receipt }),
    );
    expect(reviewed.status).toBe("halted");
    if (reviewed.status !== "halted" || reviewed.receipt === undefined) return;
    expect(reviewed.code).toBe("HIGH_RISK_FINDING");
    expect(reviewed.receipt.blockingFindingFingerprints).toEqual(
      lint.receipt.findings
        .map(({ fingerprint }) => fingerprint)
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(
      fixture.reviewer.verify(
        Object.freeze({
          ...lintInput(fixture),
          lintReceipt: lint.receipt,
          receipt: reviewed.receipt,
        }),
      ),
    ).toBe(false);
    expect(
      fixture.reviewer.review(
        Object.freeze({
          ...lintInput(fixture),
          lintReceipt: lint.receipt,
          suppressions: Object.freeze([]),
        }),
      ).status,
    ).toBe("halted");
  });

  it("rejects copied receipts, foreign assurance owners, and candidate drift", async () => {
    const first = await gateFixture({ "src/entry.ts": acceptedSource });
    const second = await gateFixture({ "src/entry.ts": acceptedSource });
    const firstLint = await first.linter.lint(lintInput(first));
    const secondLint = await second.linter.lint(lintInput(second));
    if (firstLint.status !== "completed" || secondLint.status !== "completed")
      throw new Error("lint fixture rejected");
    expect(
      first.reviewer.review(
        Object.freeze({
          ...lintInput(first),
          lintReceipt: { ...firstLint.receipt },
        }),
      ),
    ).toEqual({
      status: "halted",
      code: "SECURITY_REVIEW_BINDING_REJECTED",
    });
    expect(
      first.reviewer.review(
        Object.freeze({
          ...lintInput(second),
          lintReceipt: secondLint.receipt,
        }),
      ).status,
    ).toBe("halted");
    const target = first.assessment.targets[0];
    if (target === undefined) throw new Error("candidate fixture missing");
    const driftedAssessment = Object.freeze({
      ...first.assessment,
      targets: Object.freeze([
        Object.freeze({
          ...target,
          candidateBytes: Object.freeze([...(target.candidateBytes ?? []), 32]),
        }),
      ]),
    });
    expect(
      first.linter.verify(
        Object.freeze({
          assessment: driftedAssessment,
          assuranceReceipt: first.assuranceReceipt,
          receipt: firstLint.receipt,
        }),
      ),
    ).toBe(false);
  });

  it("requires distinct authentic authorities and contains hostile configuration", async () => {
    const fixture = await gateFixture({ "src/entry.ts": acceptedSource });
    expect(isSecurityPolicyLinter(fixture.linter)).toBe(true);
    expect(isIndependentSecurityReviewAuthority(fixture.reviewer)).toBe(true);
    expect(isSecurityPolicyLinter({ ...fixture.linter })).toBe(false);
    expect(isIndependentSecurityReviewAuthority({ ...fixture.reviewer })).toBe(
      false,
    );
    expect(
      createIndependentSecurityReviewAuthority(
        Object.freeze({
          authorityId: fixture.linter.authorityId,
          assurance: fixture.assurance,
          linter: fixture.linter,
        }),
      ),
    ).toEqual({
      status: "rejected",
      code: "INVALID_REVIEW_AUTHORITY_CONFIG",
    });
    const accessor: object = Object.create(null);
    Object.defineProperty(accessor, "authorityId", {
      enumerable: true,
      get: () => {
        throw new Error("accessor executed");
      },
    });
    Object.freeze(accessor);
    expect(createSecurityPolicyLinter(accessor)).toEqual({
      status: "rejected",
      code: "INVALID_LINTER_CONFIG",
    });
    const proxy = new Proxy(
      Object.freeze({
        authorityId: "host/proxy",
        assurance: fixture.assurance,
        policy,
      }),
      {
        get: () => {
          throw new Error("proxy executed");
        },
      },
    );
    expect(createSecurityPolicyLinter(proxy)).toEqual({
      status: "rejected",
      code: "INVALID_LINTER_CONFIG",
    });
  });

  it("emits deterministic source-free findings and receipt material", async () => {
    const fixture = await gateFixture({
      "src/entry.ts": acceptedSource.replace(
        "return request;",
        'fetch("https://example.invalid/" + String(request));\n  return request;',
      ),
    });
    const first = await fixture.linter.lint(lintInput(fixture));
    const second = await fixture.linter.lint(lintInput(fixture));
    if (first.status !== "completed" || second.status !== "completed")
      throw new Error("lint fixture rejected");
    expect(first.receipt).toEqual(second.receipt);
    const encoded = JSON.stringify(first.receipt);
    expect(encoded).not.toContain("candidateBytes");
    expect(encoded).not.toContain("https://example.invalid");
    expect(
      first.receipt.findings.every(
        ({ fingerprint, traceDigest }) =>
          fingerprint.startsWith("sha256:") &&
          traceDigest.startsWith("sha256:"),
      ),
    ).toBe(true);
  });

  it("halts the reproduced unused-interface Bun wrapper bypass", async () => {
    const fixture = await gateFixture({
      "src/entry.ts": `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
const exec = (value: string) => Bun["spawn"]([value]);
export function handle({ cmd }: { cmd: string }) {
  rateLimit(10, 60000);
  auditLog({ requestId: cmd });
  sanitizeInput(cmd);
  exec(cmd);
  return cmd;
}
`,
    });
    const lint = await fixture.linter.lint(lintInput(fixture));
    if (lint.status !== "completed") throw new Error(lint.code);
    expect(lint.receipt.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "TAINTED_EXECUTION_FLOW",
        "DYNAMIC_SECURITY_DISPATCH",
        "MISSING_SECURE_INTERFACE",
      ]),
    );
    const reviewed = fixture.reviewer.review(
      Object.freeze({ ...lintInput(fixture), lintReceipt: lint.receipt }),
    );
    expect(reviewed.status).toBe("halted");
  });

  it("halts the reproduced property-write Reflect.apply bypass", async () => {
    const fixture = await gateFixture({
      "src/entry.ts": `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
export function handle(request: { cmd: string }) {
  rateLimit(10, 60000);
  auditLog({ requestId: request });
  sanitizeInput(request);
  sessionBoundary(request);
  const channel: { value?: string } = {};
  channel.value = request.cmd;
  Reflect.apply(Bun.spawn, Bun, [[channel.value ?? ""]]);
  return request;
}
`,
    });
    const lint = await fixture.linter.lint(lintInput(fixture));
    if (lint.status !== "completed") throw new Error(lint.code);
    expect(lint.receipt.findings.map(({ code }) => code)).toContain(
      "TAINTED_EXECUTION_FLOW",
    );
    const reviewed = fixture.reviewer.review(
      Object.freeze({ ...lintInput(fixture), lintReceipt: lint.receipt }),
    );
    expect(reviewed.status).toBe("halted");
  });
});

function lintInput(fixture: {
  readonly assessment: unknown;
  readonly assuranceReceipt: unknown;
}) {
  return Object.freeze({
    assessment: fixture.assessment,
    assuranceReceipt: fixture.assuranceReceipt,
  });
}
