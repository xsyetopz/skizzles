// biome-ignore-all lint: routing learner exports pure API at declaration sites.

import type {
  RoutingArmSummary,
  RoutingCandidate,
  RoutingObservation,
  RoutingRecommendation,
  RoutingTaskProfile,
} from "./contracts.ts";
import {
  freeze,
  parseRoutingCandidate,
  parseRoutingObservation,
  workflowTokens,
} from "./parsers.ts";

const wilsonZ = 1.96;

export function routingStratum(task: RoutingTaskProfile): string {
  return [
    task.family,
    task.complexity,
    task.risk,
    task.horizon,
    task.topology,
    task.decomposition ?? "sequential",
    String(task.agentCount ?? 1),
    String(task.parallelism ?? 1),
    task.contextStrategy ?? "shared",
    [...(task.roleIdentifiers ?? [])].sort().join(","),
  ].join("|");
}

export class RoutingLearner {
  readonly #candidates: ReadonlyMap<string, RoutingCandidate>;
  readonly #observations: RoutingObservation[] = [];
  readonly #minimumSamples: number;
  readonly #minimumVerificationRate: number;
  constructor(
    candidates: readonly RoutingCandidate[],
    options: Readonly<{
      minimumSamples?: number;
      minimumVerificationRate?: number;
    }> = {},
  ) {
    if (candidates.length === 0)
      throw new Error("at least one candidate is required");
    const map = new Map<string, RoutingCandidate>();
    for (const candidate of candidates) {
      const parsed = parseRoutingCandidate(candidate);
      if (map.has(parsed.id)) throw new Error("candidate ids must be unique");
      map.set(parsed.id, parsed);
    }
    this.#candidates = map;
    this.#minimumSamples = options.minimumSamples ?? 3;
    this.#minimumVerificationRate = options.minimumVerificationRate ?? 0.8;
    if (!Number.isInteger(this.#minimumSamples) || this.#minimumSamples < 1)
      throw new Error("minimumSamples must be a positive integer");
    if (
      !Number.isFinite(this.#minimumVerificationRate) ||
      this.#minimumVerificationRate < 0 ||
      this.#minimumVerificationRate > 1
    )
      throw new Error("minimumVerificationRate must be between 0 and 1");
  }
  addObservation(value: RoutingObservation): void {
    const observation = parseRoutingObservation(value);
    if (!this.#candidates.has(observation.candidateId))
      throw new Error("observation candidate is not eligible");
    if (this.#observations.some((item) => item.id === observation.id))
      throw new Error("observation ids must be unique");
    if (
      this.#observations.some(
        (item) =>
          item.taskId === observation.taskId &&
          item.runId === observation.runId,
      )
    )
      throw new Error("task/run observations must be unique");
    this.#observations.push(observation);
  }
  summaries(task: RoutingTaskProfile): readonly RoutingArmSummary[] {
    const strata = routingStratum(task);
    return [...this.#candidates.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((candidate) => {
        const comparable = this.#observations.filter(
          (item) =>
            routingStratum(item.task) === strata &&
            isCausalAssignment(item.assignment.assignmentMethod),
        );
        const rows = this.#observations.filter(
          (item) =>
            item.candidateId === candidate.id &&
            routingStratum(item.task) === strata &&
            isCausalAssignment(item.assignment.assignmentMethod),
        );
        const successes = rows.filter((item) => isVerified(item)).length;
        const workflow = rows.reduce(
          (sum, item) => sum + workflowTokens(item.usage, item.overhead),
          0,
        );
        const verificationRate = rows.length ? successes / rows.length : 0;
        const verificationLowerBound = wilsonLowerBound(successes, rows.length);
        const attempts = rows.flatMap((item) =>
          item.attempts === undefined ? [] : [item.attempts],
        );
        const coverage =
          comparable.length === 0
            ? 0
            : comparable.filter((item) =>
                item.assignment.candidateSet.includes(candidate.id),
              ).length / comparable.length;
        return freeze({
          candidate,
          strata,
          samples: rows.length,
          successes,
          failures: rows.length - successes,
          firstPassCompletions: rows.filter((item) => item.firstPassCompletion)
            .length,
          verificationRate,
          verificationLowerBound,
          workflowTokens: workflow,
          expectedTokensPerSuccess: successes ? workflow / successes : null,
          candidateSetCoverage: coverage,
          meanLatencyMs:
            attempts.length === 0
              ? 0
              : attempts.reduce((sum, item) => sum + item.latencyMs, 0) /
                attempts.length,
          totalRetries: attempts.reduce((sum, item) => sum + item.retries, 0),
          totalEscalations: attempts.reduce(
            (sum, item) => sum + item.escalations,
            0,
          ),
          totalFollowUps: attempts.reduce(
            (sum, item) => sum + item.followUps,
            0,
          ),
        });
      });
  }
  recommend(task: RoutingTaskProfile): RoutingRecommendation | undefined {
    const eligible = this.summaries(task).filter(
      (summary) =>
        summary.samples >= this.#minimumSamples &&
        summary.successes > 0 &&
        summary.verificationLowerBound >= this.#minimumVerificationRate,
    );
    const best = eligible.sort(
      (a, b) =>
        (a.expectedTokensPerSuccess ?? Number.POSITIVE_INFINITY) -
          (b.expectedTokensPerSuccess ?? Number.POSITIVE_INFINITY) ||
        a.meanLatencyMs - b.meanLatencyMs ||
        (a.candidate.prior?.price ?? Number.POSITIVE_INFINITY) -
          (b.candidate.prior?.price ?? Number.POSITIVE_INFINITY) ||
        a.candidate.id.localeCompare(b.candidate.id),
    )[0];
    return best
      ? freeze({
          candidate: best.candidate,
          strata: best.strata,
          reason: "empirical",
          evidence: freeze({
            samples: best.samples,
            successes: best.successes,
            candidateSetCoverage: best.candidateSetCoverage,
            verificationLowerBound: best.verificationLowerBound,
          }),
        })
      : undefined;
  }
}

function wilsonLowerBound(successes: number, samples: number): number {
  if (samples === 0) return 0;
  const proportion = successes / samples;
  const denominator = 1 + (wilsonZ * wilsonZ) / samples;
  const center = proportion + (wilsonZ * wilsonZ) / (2 * samples);
  const spread =
    wilsonZ *
    Math.sqrt(
      (proportion * (1 - proportion) + (wilsonZ * wilsonZ) / (4 * samples)) /
        samples,
    );
  return Math.max(0, (center - spread) / denominator);
}

export type {
  RoutingArmSummary,
  RoutingAssignmentMethod,
  RoutingAttempts,
  RoutingCandidate,
  RoutingObservation,
  RoutingOverhead,
  RoutingReasoningEffort,
  RoutingRecommendation,
  RoutingStage,
  RoutingTaskProfile,
  RoutingUsage,
  RoutingVerification,
} from "./contracts.ts";
export {
  parseRoutingCandidate,
  parseRoutingObservation,
  parseRoutingTaskProfile,
  workflowTokens,
} from "./parsers.ts";

function isVerified(item: RoutingObservation): boolean {
  if (!item.terminalCompletion || !item.independentlyVerified) return false;
  const verification = item.verification;
  return (
    verification.deterministicChecks &&
    verification.runtimeSmoke &&
    verification.independentReview &&
    !verification.rootRescue
  );
}

function isCausalAssignment(
  method: RoutingObservation["assignment"]["assignmentMethod"],
): boolean {
  return method === "randomized" || method === "exploration";
}
