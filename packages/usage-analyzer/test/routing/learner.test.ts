// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import type { RoutingObservation } from "../../src/routing/contracts.ts";
import {
  parseRoutingCandidate,
  parseRoutingObservation,
  parseRoutingTaskProfile,
  RoutingLearner,
  workflowTokens,
} from "../../src/routing/learner.ts";

const task = parseRoutingTaskProfile({
  family: "coding",
  complexity: "medium",
  risk: "low",
  horizon: "short",
  topology: "single-agent",
});
const candidate = (id: string) => ({
  id,
  model: `model-${id}`,
  prior: { aaii: 1, price: 1 },
});
const observation = (
  id: string,
  candidateId: string,
  tokens: number,
  verified = true,
): RoutingObservation => ({
  id,
  taskId: `task-${id}`,
  runId: `run-${id}`,
  runtimeReceiptDigest: `sha256:${"2".repeat(64)}`,
  dispatchRequestDigests: [`sha256:${"3".repeat(64)}`],
  candidateId,
  task,
  usage: {
    inputTokens: tokens,
    cachedInputTokens: 0,
    uncachedInputTokens: tokens,
    outputTokens: 1,
    reasoningTokens: 0,
  },
  overhead: {
    accounting: "external-and-disjoint-from-model-usage-v1",
    duplicatedContextTokens: 2,
    repeatedRepositoryReadTokens: 0,
    reprocessedToolResultTokens: 0,
    coordinatorTokens: 3,
    reviewTokens: 0,
    correctionTokens: 0,
    retryTokens: 4,
    failedLoopTokens: 5,
    escalationTokens: 6,
    replacementTokens: 7,
  },
  stages: [
    {
      stage: "execute",
      role: "primary",
      model: `model-${candidateId}`,
      reasoningEffort: "medium",
      dispatchRequestDigest: `sha256:${"3".repeat(64)}`,
      usage: {
        inputTokens: tokens,
        cachedInputTokens: 0,
        uncachedInputTokens: tokens,
        outputTokens: 1,
        reasoningTokens: 0,
      },
    },
  ],
  attempts: {
    retries: 0,
    failedLoops: 0,
    escalations: 0,
    replacements: 0,
    followUps: 0,
    latencyMs: 10,
  },
  firstPassCompletion: verified,
  terminalCompletion: verified,
  verification: {
    deterministicChecks: verified,
    runtimeSmoke: verified,
    independentReview: verified,
    rootRescue: false,
  },
  independentlyVerified: verified,
  assignment: {
    candidateSetDigest: `sha256:${"1".repeat(64)}`,
    candidateSet: ["a", "b"],
    assignmentMethod: "randomized",
    experimentId: "routing-test",
    policyRevision: "policy-v1",
    safetyFloor: "standard",
    eligibilityDigest: `sha256:${"4".repeat(64)}`,
    propensity: 0.5,
    seed: id,
  },
});

describe("routing learner", () => {
  it("rejects malformed and privacy-sensitive input", () => {
    expect(() =>
      parseRoutingCandidate({ id: "a", model: "m", prompt: "raw" }),
    ).toThrow();
    expect(() => parseRoutingTaskProfile({ family: "x" })).toThrow();
    expect(() => parseRoutingObservation({})).toThrow();
    expect(() =>
      parseRoutingObservation(
        Object.fromEntries(
          Object.entries(observation("missing-proof", "a", 10)).filter(
            ([key]) => key !== "verification",
          ),
        ),
      ),
    ).toThrow();
    expect(
      parseRoutingCandidate({
        id: "max",
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
      }).reasoningEffort,
    ).toBe("max");
    expect(
      parseRoutingCandidate({
        id: "ultra",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      }).reasoningEffort,
    ).toBe("ultra");
  });
  it("counts workflow overhead exactly once", () => {
    expect(
      workflowTokens(
        {
          inputTokens: 10,
          cachedInputTokens: 2,
          uncachedInputTokens: 8,
          outputTokens: 4,
          reasoningTokens: 1,
        },
        {
          accounting: "external-and-disjoint-from-model-usage-v1",
          duplicatedContextTokens: 2,
          repeatedRepositoryReadTokens: 0,
          reprocessedToolResultTokens: 0,
          coordinatorTokens: 3,
          reviewTokens: 0,
          correctionTokens: 0,
          retryTokens: 4,
          failedLoopTokens: 5,
          escalationTokens: 6,
          replacementTokens: 7,
        },
      ),
    ).toBe(42);
  });
  it("gates no-success and insufficient evidence", () => {
    const learner = new RoutingLearner([candidate("a")], { minimumSamples: 2 });
    learner.addObservation(observation("1", "a", 10, false));
    expect(learner.recommend(task)).toBeUndefined();
    learner.addObservation(observation("2", "a", 10));
    expect(learner.recommend(task)).toBeUndefined();
  });
  it("changes recommendation from empirical evidence and is deterministic", () => {
    const learner = new RoutingLearner([candidate("b"), candidate("a")], {
      minimumSamples: 2,
      minimumVerificationRate: 0,
    });
    for (const id of ["1", "2"])
      learner.addObservation(observation(id, "a", 30));
    for (const id of ["3", "4"])
      learner.addObservation(observation(id, "b", 10));
    expect(learner.recommend(task)?.candidate.id).toBe("b");
    expect(learner.recommend(task)).toEqual(learner.recommend(task));
  });
  it("stratifies task profiles and requires reliability", () => {
    const learner = new RoutingLearner([candidate("a")], {
      minimumSamples: 2,
      minimumVerificationRate: 1,
    });
    learner.addObservation(observation("1", "a", 10, true));
    learner.addObservation(observation("2", "a", 10, false));
    expect(learner.summaries(task)[0]?.verificationRate).toBe(0.5);
    expect(learner.recommend(task)).toBeUndefined();
    expect(parseRoutingCandidate(candidate("a"))).toEqual(
      parseRoutingCandidate(candidate("a")),
    );
  });
  it("preserves bounded workflow dimensions and stage evidence", () => {
    const parsed = parseRoutingObservation({
      ...observation("stage-1", "a", 10),
      task: {
        ...task,
        decomposition: "parallel",
        agentCount: 2,
        parallelism: 2,
        contextStrategy: "shared",
        roleIdentifiers: ["worker"],
      },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        uncachedInputTokens: 8,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      stages: [
        {
          stage: "execute",
          role: "worker",
          model: "model-a",
          reasoningEffort: "high",
          dispatchRequestDigest: `sha256:${"3".repeat(64)}`,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 2,
            uncachedInputTokens: 8,
            outputTokens: 1,
            reasoningTokens: 0,
          },
        },
      ],
      attempts: {
        retries: 1,
        failedLoops: 0,
        escalations: 0,
        replacements: 0,
        followUps: 0,
        latencyMs: 25,
      },
      terminalCompletion: true,
      verification: {
        deterministicChecks: true,
        runtimeSmoke: true,
        independentReview: true,
        rootRescue: false,
      },
    });
    expect(parsed.stages[0]?.reasoningEffort).toBe("high");
    expect(parsed.attempts.retries).toBe(1);
    expect(parsed.task.parallelism).toBe(2);
  });
});
