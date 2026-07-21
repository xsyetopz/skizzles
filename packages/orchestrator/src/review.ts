import { bytesOf, exactKeys, isRecord, nonempty } from "./codec.ts";
import { type Digest, digestBytes, digestValue } from "./digest.ts";

export type StructuralTarget =
  | "manifest"
  | "package"
  | "build"
  | "ci"
  | "policy"
  | "schema"
  | "public-api";
export type TradeoffDimension = "security" | "performance" | "maintenance";
export type MeasurementDirection = "higher-is-better" | "lower-is-better";

export interface DimensionLimit {
  readonly dimension: TradeoffDimension;
  readonly direction: MeasurementDirection;
  readonly limit: number;
}

export interface StructuralProposal {
  readonly target: StructuralTarget;
  readonly payloadRef: string;
  readonly payloadBytes: readonly number[];
  readonly payloadDigest: Digest;
  readonly limits: readonly DimensionLimit[];
  readonly proposalDigest: Digest;
}

export interface VerifiedMeasurement {
  readonly dimension: TradeoffDimension;
  readonly unit: string;
  readonly direction: MeasurementDirection;
  readonly current: number;
  readonly proposed: number;
  readonly currentEvidenceBytes: readonly number[];
  readonly currentEvidenceDigest: Digest;
  readonly proposedEvidenceBytes: readonly number[];
  readonly proposedEvidenceDigest: Digest;
}

export interface ReviewedStructuralChange {
  readonly proposal: StructuralProposal;
  readonly measurements: readonly VerifiedMeasurement[];
  readonly measurementDigest: Digest;
  readonly reviewDigest: Digest;
}

export interface MeasurementAuthorityPort {
  measure: (input: StructuralProposal) => unknown | Promise<unknown>;
}

export interface StructuralPort {
  apply: (input: {
    readonly target: StructuralTarget;
    readonly payloadRef: string;
    readonly payloadBytes: Uint8Array;
    readonly payloadDigest: Digest;
  }) => unknown | Promise<unknown>;
}

export type ProposalResult =
  | { readonly status: "accepted"; readonly proposal: StructuralProposal }
  | {
      readonly status: "rejected";
      readonly code: "INVALID_STRUCTURAL_PROPOSAL";
    };

export type ReviewResult =
  | { readonly status: "accepted"; readonly reviewed: ReviewedStructuralChange }
  | {
      readonly status: "rejected";
      readonly code:
        | "INVALID_STRUCTURAL_PROPOSAL"
        | "MEASUREMENT_AUTHORITY_REJECTED"
        | "ADVERSARIAL_REVIEW_REQUIRED";
    };

export type StructuralResult =
  | { readonly status: "applied"; readonly result: unknown }
  | {
      readonly status: "rejected";
      readonly code:
        | "ADVERSARIAL_REVIEW_REQUIRED"
        | "MEASUREMENT_AUTHORITY_REJECTED"
        | "STRUCTURAL_REPLAY_REJECTED"
        | "STRUCTURAL_PORT_REJECTED";
    };

const targets = new Set<string>([
  "manifest",
  "package",
  "build",
  "ci",
  "policy",
  "schema",
  "public-api",
]);
const dimensions: readonly TradeoffDimension[] = [
  "security",
  "performance",
  "maintenance",
];
const directions = new Set<string>(["higher-is-better", "lower-is-better"]);
function isTarget(value: unknown): value is StructuralTarget {
  return typeof value === "string" && targets.has(value);
}

function isDimension(value: unknown): value is TradeoffDimension {
  return (
    value === "security" || value === "performance" || value === "maintenance"
  );
}

function isDirection(value: unknown): value is MeasurementDirection {
  return typeof value === "string" && directions.has(value);
}

export class StructuralReview {
  private readonly authority: MeasurementAuthorityPort;
  private readonly port: StructuralPort;
  private readonly proposals = new WeakMap<object, StructuralProposal>();
  private readonly reviews = new WeakMap<object, ReviewedStructuralChange>();
  private readonly reviewStates = new WeakMap<
    object,
    "available" | "applying" | "consumed"
  >();

  constructor(authority: MeasurementAuthorityPort, port: StructuralPort) {
    this.authority = authority;
    this.port = port;
  }

  propose(input: unknown): ProposalResult {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["target", "payloadRef", "payloadBytes", "limits"])
      ) ||
      !isTarget(input.target) ||
      !nonempty(input.payloadRef, 1024) ||
      !Array.isArray(input.limits)
    ) {
      return { status: "rejected", code: "INVALID_STRUCTURAL_PROPOSAL" };
    }
    const payloadBytes = bytesOf(input.payloadBytes);
    const limits = parseLimits(input.limits);
    if (
      payloadBytes === undefined ||
      payloadBytes.length === 0 ||
      limits === undefined
    ) {
      return { status: "rejected", code: "INVALID_STRUCTURAL_PROPOSAL" };
    }
    const payloadDigest = digestBytes(Uint8Array.from(payloadBytes));
    const material = {
      target: input.target,
      payloadRef: input.payloadRef,
      payloadDigest,
      limits,
    };
    const proposal: StructuralProposal = Object.freeze({
      ...material,
      payloadBytes,
      proposalDigest: digestValue(material),
    });
    this.proposals.set(proposal, proposal);
    return { status: "accepted", proposal };
  }

  async review(input: unknown): Promise<ReviewResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["proposal"]) &&
        isRecord(input.proposal) &&
        this.proposals.has(input.proposal)
      )
    ) {
      return { status: "rejected", code: "INVALID_STRUCTURAL_PROPOSAL" };
    }
    const proposal = this.proposals.get(input.proposal);
    if (proposal === undefined) {
      return { status: "rejected", code: "INVALID_STRUCTURAL_PROPOSAL" };
    }
    if (!validProposal(proposal, this.proposals)) {
      return { status: "rejected", code: "INVALID_STRUCTURAL_PROPOSAL" };
    }
    let raw: unknown;
    try {
      raw = await this.authority.measure(proposal);
    } catch {
      return { status: "rejected", code: "MEASUREMENT_AUTHORITY_REJECTED" };
    }
    const measurements = parseMeasurements(raw, proposal);
    if (measurements === undefined) {
      return { status: "rejected", code: "MEASUREMENT_AUTHORITY_REJECTED" };
    }
    if (
      !measurements.every((measurement) => acceptable(measurement, proposal))
    ) {
      return { status: "rejected", code: "ADVERSARIAL_REVIEW_REQUIRED" };
    }
    const measurementDigest = digestMeasurements(measurements);
    const reviewDigest = digestValue({
      proposalDigest: proposal.proposalDigest,
      measurementDigest,
    });
    const reviewed: ReviewedStructuralChange = Object.freeze({
      proposal,
      measurements,
      measurementDigest,
      reviewDigest,
    });
    this.reviews.set(reviewed, reviewed);
    this.reviewStates.set(reviewed, "available");
    return { status: "accepted", reviewed };
  }

  async apply(input: unknown): Promise<StructuralResult> {
    if (
      !(
        isRecord(input) &&
        exactKeys(input, ["reviewed"]) &&
        isRecord(input.reviewed) &&
        this.reviews.has(input.reviewed)
      )
    ) {
      return { status: "rejected", code: "ADVERSARIAL_REVIEW_REQUIRED" };
    }
    const reviewed = this.reviews.get(input.reviewed);
    if (reviewed === undefined) {
      return { status: "rejected", code: "ADVERSARIAL_REVIEW_REQUIRED" };
    }
    if (this.reviewStates.get(reviewed) !== "available") {
      return { status: "rejected", code: "STRUCTURAL_REPLAY_REJECTED" };
    }
    this.reviewStates.set(reviewed, "applying");
    try {
      if (
        !validProposal(reviewed.proposal, this.proposals) ||
        digestValue({
          proposalDigest: reviewed.proposal.proposalDigest,
          measurementDigest: reviewed.measurementDigest,
        }) !== reviewed.reviewDigest ||
        !reviewed.measurements.every((measurement) =>
          acceptable(measurement, reviewed.proposal),
        )
      ) {
        return { status: "rejected", code: "ADVERSARIAL_REVIEW_REQUIRED" };
      }
      let raw: unknown;
      try {
        raw = await this.authority.measure(reviewed.proposal);
      } catch {
        return { status: "rejected", code: "MEASUREMENT_AUTHORITY_REJECTED" };
      }
      const refreshed = parseMeasurements(raw, reviewed.proposal);
      if (refreshed === undefined) {
        return { status: "rejected", code: "MEASUREMENT_AUTHORITY_REJECTED" };
      }
      if (
        digestMeasurements(refreshed) !== reviewed.measurementDigest ||
        !refreshed.every((measurement) =>
          acceptable(measurement, reviewed.proposal),
        )
      ) {
        return { status: "rejected", code: "ADVERSARIAL_REVIEW_REQUIRED" };
      }
      return {
        status: "applied",
        result: await this.port.apply(
          Object.freeze({
            target: reviewed.proposal.target,
            payloadRef: reviewed.proposal.payloadRef,
            payloadBytes: Uint8Array.from(reviewed.proposal.payloadBytes),
            payloadDigest: reviewed.proposal.payloadDigest,
          }),
        ),
      };
    } catch {
      return { status: "rejected", code: "STRUCTURAL_PORT_REJECTED" };
    } finally {
      this.reviewStates.set(reviewed, "consumed");
    }
  }
}

function parseLimits(
  value: readonly unknown[],
): readonly DimensionLimit[] | undefined {
  if (value.length !== dimensions.length) {
    return;
  }
  const parsed: DimensionLimit[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !(
        isRecord(item) && exactKeys(item, ["dimension", "direction", "limit"])
      ) ||
      !isDimension(item.dimension) ||
      seen.has(item.dimension) ||
      !isDirection(item.direction) ||
      typeof item.limit !== "number" ||
      !Number.isFinite(item.limit)
    ) {
      return;
    }
    seen.add(item.dimension);
    parsed.push(
      Object.freeze({
        dimension: item.dimension,
        direction: item.direction,
        limit: item.limit,
      }),
    );
  }
  parsed.sort(
    (left, right) =>
      dimensions.indexOf(left.dimension) - dimensions.indexOf(right.dimension),
  );
  return Object.freeze(parsed);
}

function parseMeasurements(
  value: unknown,
  proposal: StructuralProposal,
): readonly VerifiedMeasurement[] | undefined {
  if (
    !(
      isRecord(value) && exactKeys(value, ["proposalDigest", "measurements"])
    ) ||
    value.proposalDigest !== proposal.proposalDigest ||
    !Array.isArray(value.measurements) ||
    value.measurements.length !== dimensions.length
  ) {
    return;
  }
  const parsed: VerifiedMeasurement[] = [];
  const seen = new Set<string>();
  for (const item of value.measurements) {
    if (
      !(
        isRecord(item) &&
        exactKeys(item, [
          "dimension",
          "unit",
          "direction",
          "current",
          "proposed",
          "currentEvidenceBytes",
          "proposedEvidenceBytes",
        ])
      ) ||
      !isDimension(item.dimension) ||
      seen.has(item.dimension) ||
      !nonempty(item.unit, 64) ||
      !isDirection(item.direction) ||
      typeof item.current !== "number" ||
      !Number.isFinite(item.current) ||
      typeof item.proposed !== "number" ||
      !Number.isFinite(item.proposed)
    ) {
      return;
    }
    const currentBytes = bytesOf(item.currentEvidenceBytes);
    const proposedBytes = bytesOf(item.proposedEvidenceBytes);
    if (
      currentBytes === undefined ||
      currentBytes.length === 0 ||
      proposedBytes === undefined ||
      proposedBytes.length === 0
    ) {
      return;
    }
    seen.add(item.dimension);
    parsed.push(
      Object.freeze({
        dimension: item.dimension,
        unit: item.unit,
        direction: item.direction,
        current: item.current,
        proposed: item.proposed,
        currentEvidenceBytes: currentBytes,
        currentEvidenceDigest: digestBytes(Uint8Array.from(currentBytes)),
        proposedEvidenceBytes: proposedBytes,
        proposedEvidenceDigest: digestBytes(Uint8Array.from(proposedBytes)),
      }),
    );
  }
  parsed.sort(
    (left, right) =>
      dimensions.indexOf(left.dimension) - dimensions.indexOf(right.dimension),
  );
  return Object.freeze(parsed);
}

function acceptable(
  measurement: VerifiedMeasurement,
  proposal: StructuralProposal,
): boolean {
  const limit = proposal.limits.find(
    (item) => item.dimension === measurement.dimension,
  );
  if (limit === undefined || limit.direction !== measurement.direction) {
    return false;
  }
  return measurement.direction === "higher-is-better"
    ? measurement.proposed >= measurement.current &&
        measurement.proposed >= limit.limit
    : measurement.proposed <= measurement.current &&
        measurement.proposed <= limit.limit;
}

function validProposal(
  proposal: StructuralProposal,
  proposals: WeakMap<object, StructuralProposal>,
): boolean {
  return (
    proposals.has(proposal) &&
    digestBytes(Uint8Array.from(proposal.payloadBytes)) ===
      proposal.payloadDigest &&
    digestValue({
      target: proposal.target,
      payloadRef: proposal.payloadRef,
      payloadDigest: proposal.payloadDigest,
      limits: proposal.limits,
    }) === proposal.proposalDigest
  );
}

function digestMeasurements(
  measurements: readonly VerifiedMeasurement[],
): Digest {
  return digestValue(
    measurements.map(
      ({
        currentEvidenceBytes: _current,
        proposedEvidenceBytes: _proposed,
        ...item
      }) => item,
    ),
  );
}
