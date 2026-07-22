// biome-ignore-all lint: routing events use explicit trust-boundary checks and public constructors.

import { type Digest, digestValue } from "../digest.ts";
import type { OutboundContextPayload } from "./context/contract.ts";
import {
  isRoutingAssignment,
  type RoutingAssignment,
} from "./routing-contract.ts";

const observers = new WeakSet<object>();
const events = new WeakSet<object>();
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumDispatchDigests = 128;

export type RoutingExperimentMode = "agentless" | "react";

export interface RoutingExperimentEvent {
  readonly schema: "skizzles.orchestrator/routing-experiment-event/v1";
  readonly taskId: string;
  readonly runId: string;
  readonly objectiveDigest: Digest;
  readonly mode: RoutingExperimentMode;
  readonly assignment: RoutingAssignment | null;
  readonly dispatchRequestDigests: readonly Digest[];
  readonly executionId: Digest | null;
  readonly context: Readonly<{
    payloadDigest: Digest | null;
    beforeTokenEstimate: number;
    afterTokenEstimate: number;
    placementCount: number;
    bookendPlacementCount: number;
    compressionBeforeTokenEstimate: number | null;
    compressionAfterTokenEstimate: number | null;
  }>;
  readonly outcome: "awaiting-approval" | "failed";
  readonly failureCode: string | null;
  readonly engineeringEvidenceDigest: Digest | null;
  readonly eventDigest: Digest;
}

export interface RoutingExperimentObserver {
  readonly schema: "skizzles.orchestrator/routing-experiment-observer/v1";
  readonly authorityId: string;
  readonly record: (event: RoutingExperimentEvent) => Promise<void>;
}

export type RoutingExperimentObserverCreationResult =
  | Readonly<{
      status: "created";
      observer: RoutingExperimentObserver;
    }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_ROUTING_EXPERIMENT_OBSERVER";
    }>;

type RawRecorder = (
  event: RoutingExperimentEvent,
) => unknown | Promise<unknown>;

export function createRoutingExperimentObserver(
  input: unknown,
): RoutingExperimentObserverCreationResult {
  const config = parseObserverConfig(input);
  if (config === undefined) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_ROUTING_EXPERIMENT_OBSERVER" as const,
    });
  }
  const observer: RoutingExperimentObserver = Object.freeze({
    schema: "skizzles.orchestrator/routing-experiment-observer/v1" as const,
    authorityId: config.authorityId,
    record: async (event: RoutingExperimentEvent) => {
      if (
        typeof event !== "object" ||
        !events.has(event) ||
        !Object.isFrozen(event)
      ) {
        throw new TypeError("untrusted routing experiment event");
      }
      await config.record(event);
    },
  });
  observers.add(observer);
  return Object.freeze({ status: "created" as const, observer });
}

export function isRoutingExperimentObserver(
  value: unknown,
): value is RoutingExperimentObserver {
  return (
    typeof value === "object" &&
    value !== null &&
    observers.has(value) &&
    Object.isFrozen(value)
  );
}

export function createRoutingExperimentEvent(input: {
  readonly taskId: string;
  readonly runId: string;
  readonly objectiveDigest: Digest;
  readonly mode: RoutingExperimentMode;
  readonly assignment: RoutingAssignment | null;
  readonly dispatchRequestDigests: readonly Digest[];
  readonly executionId: Digest | null;
  readonly context: OutboundContextPayload | null;
  readonly outcome: "awaiting-approval" | "failed";
  readonly failureCode: string | null;
  readonly engineeringEvidenceDigest: Digest | null;
}): RoutingExperimentEvent {
  if (
    !(validIdentifier(input.taskId) && validIdentifier(input.runId)) ||
    !validDigest(input.objectiveDigest) ||
    (input.mode !== "agentless" && input.mode !== "react") ||
    (input.assignment !== null && !isRoutingAssignment(input.assignment)) ||
    !Array.isArray(input.dispatchRequestDigests) ||
    input.dispatchRequestDigests.length > maximumDispatchDigests ||
    input.dispatchRequestDigests.some((digest) => !validDigest(digest)) ||
    (input.executionId !== null && !validDigest(input.executionId)) ||
    (input.engineeringEvidenceDigest !== null &&
      !validDigest(input.engineeringEvidenceDigest)) ||
    (input.failureCode !== null && !validIdentifier(input.failureCode)) ||
    (input.outcome !== "awaiting-approval" && input.outcome !== "failed")
  ) {
    throw new TypeError("invalid routing experiment event");
  }
  const body = Object.freeze({
    schema: "skizzles.orchestrator/routing-experiment-event/v1" as const,
    taskId: input.taskId,
    runId: input.runId,
    objectiveDigest: input.objectiveDigest,
    mode: input.mode,
    assignment: input.assignment,
    dispatchRequestDigests: Object.freeze([...input.dispatchRequestDigests]),
    executionId: input.executionId,
    context: contextRecord(input.context),
    outcome: input.outcome,
    failureCode: input.failureCode,
    engineeringEvidenceDigest: input.engineeringEvidenceDigest,
  });
  const event: RoutingExperimentEvent = Object.freeze({
    ...body,
    eventDigest: digestValue(body),
  });
  events.add(event);
  return event;
}

export function isRoutingExperimentEvent(
  value: unknown,
): value is RoutingExperimentEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    events.has(value) &&
    Object.isFrozen(value)
  );
}

function parseObserverConfig(
  input: unknown,
): Readonly<{ authorityId: string; record: RawRecorder }> | undefined {
  try {
    if (typeof input !== "object" || input === null || !Object.isFrozen(input)) {
      return;
    }
    const entries = Reflect.ownKeys(input);
    if (
      entries.length !== 2 ||
      !entries.includes("authorityId") ||
      !entries.includes("record")
    ) {
      return;
    }
    const authority = Object.getOwnPropertyDescriptor(input, "authorityId");
    const record = Object.getOwnPropertyDescriptor(input, "record");
    if (
      authority === undefined ||
      record === undefined ||
      !("value" in authority) ||
      !("value" in record) ||
      !validIdentifier(authority.value) ||
      !isRecorder(record.value)
    ) {
      return;
    }
    return Object.freeze({
      authorityId: authority.value,
      record: record.value,
    });
  } catch {
    return;
  }
}

function contextRecord(
  payload: OutboundContextPayload | null,
): RoutingExperimentEvent["context"] {
  if (payload === null) {
    return Object.freeze({
      payloadDigest: null,
      beforeTokenEstimate: 0,
      afterTokenEstimate: 0,
      placementCount: 0,
      bookendPlacementCount: 0,
      compressionBeforeTokenEstimate: null,
      compressionAfterTokenEstimate: null,
    });
  }
  const { placements } = payload.prioritization;
  return Object.freeze({
    payloadDigest: payload.payloadDigest,
    beforeTokenEstimate: payload.beforeTokenEstimate,
    afterTokenEstimate: payload.afterTokenEstimate,
    placementCount: placements.length,
    bookendPlacementCount: placements.filter(
      ({ region }) => region === "beginning" || region === "end",
    ).length,
    compressionBeforeTokenEstimate:
      payload.compression?.beforeTokenEstimate ?? null,
    compressionAfterTokenEstimate:
      payload.compression?.afterTokenEstimate ?? null,
  });
}

function isRecorder(value: unknown): value is RawRecorder {
  return typeof value === "function";
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}
