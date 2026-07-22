// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { digestValue } from "../../src/digest.ts";
import {
  createRoutingAssignment,
  isRoutingAssignment,
  parseRoutingAssignment,
} from "../../src/paradigms/routing-contract.ts";
import {
  createRoutingExperimentEvent,
  createRoutingExperimentObserver,
} from "../../src/paradigms/routing-observer.ts";

const objectiveDigest = `sha256:${"a".repeat(64)}` as const;

function assignment() {
  return createRoutingAssignment({
    experimentId: "routing-experiment",
    policyRevision: "policy-v1",
    safetyFloor: "standard",
    eligibilityDigest: `sha256:${"b".repeat(64)}`,
    candidateId: "candidate-a",
    candidateSet: Object.freeze(["candidate-a", "candidate-b"]),
    assignmentMethod: "randomized",
    propensity: 0.5,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    workflow: Object.freeze({
      topology: "multi-agent",
      decomposition: "parallel",
      agentCount: 2,
      maximumParallelism: 2,
      contextStrategy: "bounded-digest",
    }),
  });
}

describe("routing experiment observer", () => {
  it("round-trips digest-bound assignments without accepting unknown fields", () => {
    const created = assignment();
    const parsed = parseRoutingAssignment(structuredClone(created));
    expect(parsed).toBeDefined();
    expect(isRoutingAssignment(parsed)).toBe(true);
    expect(
      parseRoutingAssignment({ ...created, prompt: "do not retain" }),
    ).toBe(undefined);
  });

  it("records only authentic digest-only terminal events", async () => {
    const events: unknown[] = [];
    const observerResult = createRoutingExperimentObserver(
      Object.freeze({
        authorityId: "routing-recorder",
        record: (event: unknown) => {
          events.push(event);
        },
      }),
    );
    expect(observerResult.status).toBe("created");
    if (observerResult.status !== "created") return;
    const event = createRoutingExperimentEvent({
      taskId: "task-routing",
      runId: "run-routing",
      objectiveDigest,
      mode: "agentless",
      assignment: assignment(),
      dispatchRequestDigests: Object.freeze([objectiveDigest]),
      executionId: objectiveDigest,
      context: null,
      outcome: "failed",
      failureCode: "VERIFY_FAILED",
      engineeringEvidenceDigest: null,
    });

    await observerResult.observer.record(event);
    expect(events).toEqual([event]);
    expect(event.context).toMatchObject({
      payloadDigest: null,
      beforeTokenEstimate: 0,
      placementCount: 0,
    });
    await expect(observerResult.observer.record({ ...event })).rejects.toThrow(
      "untrusted routing experiment event",
    );
    const { eventDigest, ...eventBody } = event;
    expect(eventDigest).toBe(digestValue(eventBody));
  });
});
