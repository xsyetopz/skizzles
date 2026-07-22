// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import { digestBytes } from "../src/security/digest.ts";
import {
  createSessionBoundaryAuthority,
  createSessionBoundaryRuntime,
  type SessionProbeRequest,
} from "../src/security/index.ts";

describe("session boundary authority", () => {
  const runtime = createSessionBoundaryRuntime(
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

  it("runs all six boundary cases against exact frozen bindings", async () => {
    expect(runtime.status).toBe("created");
    if (runtime.status !== "created") {
      return;
    }
    const created = createSessionBoundaryAuthority({
      requiredRole: "admin",
      maximumSessionAgeMs: 60_000,
      refreshWindowMs: 10_000,
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      return;
    }
    const bytes = Object.freeze([
      ...new TextEncoder().encode("export const ok = true;\n"),
    ]);
    const digest = digestBytes(Uint8Array.from(bytes));
    const validTargets = Object.freeze([
      Object.freeze({
        path: "src/entry.ts",
        candidateDigest: digest,
        candidateBytes: bytes,
      }),
    ]);
    const bound = created.authority.bindTargets(validTargets);
    expect(bound.status).toBe("bound");
    if (bound.status !== "bound") {
      return;
    }
    const result = await created.authority.inspect(
      Object.freeze({
        candidateTargets: bound.targets,
        runtime: runtime.runtime,
      }),
    );
    expect(result.status).toBe("accepted");
    expect(result.caseReceipts).toHaveLength(6);
    const forgedTargets = Object.freeze([...validTargets]);
    expect(
      created.authority.inspect(
        Object.freeze({
          candidateTargets: forgedTargets,
          runtime: runtime.runtime,
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "SESSION_BOUNDARY_FORGED",
    });
  });

  it("rejects self-reported or incomplete runtime outcomes", async () => {
    const fake = createSessionBoundaryRuntime(
      async (_request: SessionProbeRequest) => ({
        decision: "allow",
        state: "active",
      }),
    );
    expect(fake.status).toBe("created");
    if (fake.status !== "created") {
      return;
    }
    const created = createSessionBoundaryAuthority({
      requiredRole: "admin",
      maximumSessionAgeMs: 60_000,
      refreshWindowMs: 10_000,
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      return;
    }
    const bytes = Object.freeze([
      ...new TextEncoder().encode("export const ok = true;\n"),
    ]);
    const digest = digestBytes(Uint8Array.from(bytes));
    const targets = Object.freeze([
      Object.freeze({
        path: "src/entry.ts",
        candidateDigest: digest,
        candidateBytes: bytes,
      }),
    ]);
    const bound = created.authority.bindTargets(targets);
    expect(bound.status).toBe("bound");
    if (bound.status !== "bound") {
      return;
    }
    const result = await created.authority.inspect(
      Object.freeze({ candidateTargets: bound.targets, runtime: fake.runtime }),
    );
    expect(result.status).toBe("rejected");
    expect(result.code).toBe("SESSION_BOUNDARY_REJECTED");
  });
});
