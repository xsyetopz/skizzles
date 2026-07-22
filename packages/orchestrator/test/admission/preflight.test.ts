import { describe, expect, it } from "bun:test";
import { createHarness, normalize, requestBytes } from "../facade/support.ts";

describe("authority-bound preflight", () => {
  it("rejects forged caller graph evidence before spawn", async () => {
    const { orchestrator, counts } = createHarness();
    const result = await orchestrator.run({
      rawRequest: requestBytes(),
      repository: { id: "repo-a" },
      checks: [
        {
          id: "dependency-direction",
          state: "satisfied",
          evidence: "forged-local-evidence",
        },
      ],
    });
    expect(result).toEqual({
      status: "rejected",
      code: "INVALID_REQUEST_ENVELOPE",
    });
    expect(counts.spawn).toBe(0);
    expect(counts.graph).toBe(0);
  });

  it("rejects graph snapshots unbound from repository and request", async () => {
    const { orchestrator, counts } = createHarness({
      graphResult: (input) => ({
        repositoryId: input.repositoryId,
        requestDigest: "sha256:forged",
        treeDigest: input.treeDigest,
        snapshotBytes: [1],
        invariants: [
          {
            id: "dependency-direction",
            state: "satisfied",
            evidence: [{ source: "forged", bytes: [1] }],
          },
        ],
      }),
    });
    const result = await orchestrator.run({
      rawRequest: requestBytes(),
      repository: { id: "repo-a" },
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("GRAPH_AUTHORITY_REJECTED");
    }
    expect(counts.spawn).toBe(0);
  });

  it("keeps rejection and approval spawn counts at zero", async () => {
    for (const state of ["violated", "approval-required"] as const) {
      const { orchestrator, counts } = createHarness({ graphState: state });
      const result = await orchestrator.run({
        rawRequest: requestBytes(),
        repository: { id: "repo-a" },
      });
      expect(result.status).toBe(
        state === "violated" ? "rejected" : "needs-approval",
      );
      expect(counts.spawn).toBe(0);
    }
  });

  it("accepts only a branded request and authority-captured anchors", async () => {
    const { orchestrator } = createHarness();
    const request = normalize(orchestrator);
    const accepted = await orchestrator.preflight({
      request,
      repository: { id: "repo-a" },
    });
    expect(accepted.status).toBe("accepted");
    if (accepted.status === "accepted") {
      expect(accepted.approval.repository.anchors[0]?.repositoryId).toBe(
        "repo-a",
      );
      expect(accepted.approval.repository.anchors[0]?.requestDigest).toBe(
        request.intentDigest,
      );
      expect(Object.isFrozen(accepted.approval.repository.anchors[0])).toBe(
        true,
      );
    }
    expect(
      await orchestrator.preflight({
        request: { ...request },
        repository: { id: "repo-a" },
      }),
    ).toMatchObject({ status: "rejected", code: "INVALID_PREFLIGHT_INPUT" });
  });
});
