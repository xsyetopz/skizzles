// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { createHarness, measurementResult, proposal } from "./support.ts";

describe("authority-measured structural review", () => {
  it("rejects a worse proposal in every dimension", async () => {
    const { orchestrator, counts } = createHarness({
      measurements: (item) => measurementResult(item, 7, 5),
    });
    const result = await orchestrator.reviewChange({
      proposal: proposal(orchestrator),
    });
    expect(result).toEqual({
      status: "rejected",
      code: "ADVERSARIAL_REVIEW_REQUIRED",
    });
    expect(counts.measure).toBe(1);
    expect(counts.apply).toBe(0);
  });

  it("rejects caller-fabricated measurements and authority binding drift", async () => {
    const { orchestrator, counts } = createHarness();
    const item = proposal(orchestrator);
    expect(
      await orchestrator.reviewChange({
        proposal: item,
        measurements: measurementResult(item, 5, 10),
      }),
    ).toEqual({ status: "rejected", code: "INVALID_STRUCTURAL_PROPOSAL" });
    expect(counts.measure).toBe(0);

    const drift = createHarness({
      measurements: (candidate) => ({
        ...measurementResult(candidate, 5, 7),
        proposalDigest: "unbound",
      }),
    });
    expect(
      await drift.orchestrator.reviewChange({
        proposal: proposal(drift.orchestrator),
      }),
    ).toEqual({
      status: "rejected",
      code: "MEASUREMENT_AUTHORITY_REJECTED",
    });
  });

  it("binds immutable exact payload bytes through review and application", async () => {
    const { orchestrator, counts, applied } = createHarness();
    const source = new TextEncoder().encode('{"private":true}\n');
    const proposed = orchestrator.proposeChange({
      target: "manifest",
      payloadRef: "workspace:package.json",
      payloadBytes: source,
      limits: [
        { dimension: "security", direction: "higher-is-better", limit: 6 },
        { dimension: "performance", direction: "higher-is-better", limit: 6 },
        { dimension: "maintenance", direction: "higher-is-better", limit: 6 },
      ],
    });
    if (proposed.status === "rejected") {
      throw new Error("fixture rejected");
    }
    source.fill(0);
    const reviewed = await orchestrator.reviewChange({
      proposal: proposed.proposal,
    });
    if (reviewed.status === "rejected") {
      throw new Error("review rejected");
    }
    expect(Object.isFrozen(reviewed.reviewed.proposal.payloadBytes)).toBe(true);
    expect(
      await orchestrator.applyChange({
        reviewed: { ...reviewed.reviewed },
      }),
    ).toEqual({ status: "rejected", code: "ADVERSARIAL_REVIEW_REQUIRED" });
    const appliedResult = await orchestrator.applyChange({
      reviewed: reviewed.reviewed,
    });
    expect(appliedResult.status).toBe("applied");
    expect(counts.apply).toBe(1);
    expect(counts.measure).toBe(2);
    expect(new TextDecoder().decode(applied[0])).toBe('{"private":true}\n');
    expect(
      await orchestrator.applyChange({ reviewed: reviewed.reviewed }),
    ).toEqual({
      status: "rejected",
      code: "STRUCTURAL_REPLAY_REJECTED",
    });
    expect(counts.apply).toBe(1);
  });

  it("rejects limits exceeded even without a current-value regression", async () => {
    const { orchestrator } = createHarness({
      measurements: (item) => measurementResult(item, 5, 5.5),
    });
    expect(
      await orchestrator.reviewChange({ proposal: proposal(orchestrator) }),
    ).toEqual({
      status: "rejected",
      code: "ADVERSARIAL_REVIEW_REQUIRED",
    });
  });

  it("reserves a reviewed change against concurrent application", async () => {
    const refresh = deferred<unknown>();
    let measurements = 0;
    const { orchestrator, counts } = createHarness({
      measurements: (item) => {
        measurements += 1;
        return measurements === 1
          ? measurementResult(item, 5, 7)
          : refresh.promise;
      },
    });
    const reviewed = await orchestrator.reviewChange({
      proposal: proposal(orchestrator),
    });
    if (reviewed.status === "rejected") throw new Error("review rejected");
    const first = orchestrator.applyChange({ reviewed: reviewed.reviewed });
    await Promise.resolve();
    expect(
      await orchestrator.applyChange({ reviewed: reviewed.reviewed }),
    ).toEqual({
      status: "rejected",
      code: "STRUCTURAL_REPLAY_REJECTED",
    });
    refresh.resolve(measurementResult(reviewed.reviewed.proposal, 5, 7));
    expect((await first).status).toBe("applied");
    expect(counts.apply).toBe(1);
  });

  it("consumes stale review evidence when measurements drift", async () => {
    let measurements = 0;
    const { orchestrator, counts } = createHarness({
      measurements: (item) => {
        measurements += 1;
        return measurementResult(item, 5, measurements === 1 ? 7 : 8);
      },
    });
    const reviewed = await orchestrator.reviewChange({
      proposal: proposal(orchestrator),
    });
    if (reviewed.status === "rejected") throw new Error("review rejected");
    expect(
      await orchestrator.applyChange({ reviewed: reviewed.reviewed }),
    ).toEqual({
      status: "rejected",
      code: "ADVERSARIAL_REVIEW_REQUIRED",
    });
    expect(counts.apply).toBe(0);
    expect(
      await orchestrator.applyChange({ reviewed: reviewed.reviewed }),
    ).toEqual({
      status: "rejected",
      code: "STRUCTURAL_REPLAY_REJECTED",
    });
  });

  it("requires a fresh review after an uncertain structural port failure", async () => {
    const { orchestrator, counts } = createHarness({
      structuralApply() {
        throw new Error("effect outcome is uncertain");
      },
    });
    const reviewed = await orchestrator.reviewChange({
      proposal: proposal(orchestrator),
    });
    if (reviewed.status === "rejected") throw new Error("review rejected");
    expect(
      await orchestrator.applyChange({ reviewed: reviewed.reviewed }),
    ).toEqual({
      status: "rejected",
      code: "STRUCTURAL_PORT_REJECTED",
    });
    expect(counts.apply).toBe(1);
    expect(
      await orchestrator.applyChange({ reviewed: reviewed.reviewed }),
    ).toEqual({
      status: "rejected",
      code: "STRUCTURAL_REPLAY_REJECTED",
    });
  });

  it("does not trust a review issued by another controller", async () => {
    const first = createHarness();
    const second = createHarness();
    const reviewed = await first.orchestrator.reviewChange({
      proposal: proposal(first.orchestrator),
    });
    if (reviewed.status === "rejected") throw new Error("review rejected");
    expect(
      await second.orchestrator.applyChange({ reviewed: reviewed.reviewed }),
    ).toEqual({
      status: "rejected",
      code: "ADVERSARIAL_REVIEW_REQUIRED",
    });
    expect(second.counts.measure).toBe(0);
    expect(second.counts.apply).toBe(0);
  });
});

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: Value) {
      resolvePromise?.(value);
    },
  };
}
