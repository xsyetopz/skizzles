import { basename } from "node:path";
import { rolloutId } from "./rollout-discovery.ts";
import { readEvents } from "./rollout-reader.ts";
import type {
  Actor,
  Options,
  ParsedRollout,
  RateSnapshot,
  SessionSummary,
} from "./types.ts";
import {
  addUsage,
  aggregateInto,
  asNumber,
  asString,
  bucketKey,
  emptyUsage,
  nestedProperty,
  parseJsonObject,
  property,
  usageDelta,
  usageFrom,
} from "./usage.ts";

function classify(source: unknown): Actor {
  const subagent = property(source, "subagent");
  if (property(subagent, "other") === "guardian") {
    return "guardian";
  }
  if (subagent) {
    return "subagent";
  }
  if (source === "vscode" || source === "cli" || source === "exec") {
    return "root";
  }
  return "other";
}

type ForkBoundary = { forked: boolean; turnId?: string };

async function findForkBoundary(path: string): Promise<ForkBoundary> {
  let forked = false;
  let turnId: string | undefined;
  for await (const event of readEvents(path)) {
    const payload = property(event, "payload");
    if (property(event, "type") === "session_meta") {
      forked =
        classify(property(payload, "source")) === "subagent" &&
        typeof property(payload, "forked_from_id") === "string";
      if (!forked) {
        return { forked: false };
      }
    }
    if (
      forked &&
      property(event, "type") === "event_msg" &&
      property(payload, "type") === "task_started"
    ) {
      turnId = asString(property(payload, "turn_id")) ?? turnId;
    }
  }
  return { forked, ...(turnId ? { turnId } : {}) };
}

function createSession(path: string): SessionSummary {
  return {
    id: rolloutId(path) ?? basename(path),
    actor: "other",
    usage: emptyUsage(),
    inferences: 0,
    models: new Map(),
    routes: new Map(),
    reviewCount: 0,
    reviewAllow: 0,
    reviewDeny: 0,
    reviewDurationMs: 0,
  };
}

function readSessionMeta(session: SessionSummary, payload: unknown): void {
  session.id =
    asString(property(payload, "id")) ??
    asString(property(payload, "session_id")) ??
    session.id;
  session.actor = classify(property(payload, "source"));
  const parentId =
    asString(property(payload, "parent_thread_id")) ??
    asString(
      nestedProperty(payload, [
        "source",
        "subagent",
        "thread_spawn",
        "parent_thread_id",
      ]),
    );
  const agentPath =
    asString(property(payload, "agent_path")) ??
    asString(
      nestedProperty(payload, [
        "source",
        "subagent",
        "thread_spawn",
        "agent_path",
      ]),
    );
  if (parentId !== undefined) {
    session.parentId = parentId;
  }
  if (agentPath !== undefined) {
    session.agentPath = agentPath;
  }
}

type ParseState = {
  currentModel: string;
  currentEffort: string;
  previousTotal?: unknown;
  previousSignature?: string;
  reachedOwnTurn: boolean;
};

function updatePreviousUsage(state: ParseState, payload: unknown): void {
  const total = nestedProperty(payload, ["info", "total_token_usage"]);
  state.previousTotal = total ?? state.previousTotal;
  if (state.previousTotal) {
    state.previousSignature = JSON.stringify(state.previousTotal);
  }
}

function readTurnContext(
  state: ParseState,
  payload: unknown,
  forkBoundary: ForkBoundary,
): void {
  if (
    forkBoundary.forked &&
    forkBoundary.turnId !== undefined &&
    property(payload, "turn_id") === forkBoundary.turnId
  ) {
    state.reachedOwnTurn = true;
  }
  if (!state.reachedOwnTurn) {
    return;
  }
  state.currentModel =
    asString(property(payload, "model")) ?? state.currentModel;
  state.currentEffort =
    asString(property(payload, "effort")) ??
    asString(property(payload, "reasoning_effort")) ??
    state.currentEffort;
}

function readRateSnapshot(
  rates: RateSnapshot[],
  payload: unknown,
  timestamp: number,
): void {
  const primary = nestedProperty(payload, ["rate_limits", "primary"]);
  const usedPercent = property(primary, "used_percent");
  if (typeof usedPercent !== "number") {
    return;
  }
  const resetsAt = property(primary, "resets_at");
  rates.push({
    timestamp,
    usedPercent,
    ...(typeof resetsAt === "number" ? { resetsAt: resetsAt * 1000 } : {}),
  });
}

function readTokenCount(
  parsed: ParsedRollout,
  state: ParseState,
  payload: unknown,
  timestamp: number,
  options: Options,
): void {
  const total = nestedProperty(payload, ["info", "total_token_usage"]);
  const signature = total ? JSON.stringify(total) : undefined;
  if (!state.reachedOwnTurn) {
    state.previousTotal = total ?? state.previousTotal;
    if (signature !== undefined) {
      state.previousSignature = signature;
    }
    return;
  }
  if (signature && signature === state.previousSignature) {
    return;
  }
  const rawLast = nestedProperty(payload, ["info", "last_token_usage"]);
  const usage = rawLast
    ? usageFrom(rawLast, options.cachedWeight)
    : usageDelta(total, state.previousTotal, options.cachedWeight);
  state.previousTotal = total ?? state.previousTotal;
  if (signature !== undefined) {
    state.previousSignature = signature;
  }
  if (usage.total <= 0 && usage.input <= 0 && usage.output <= 0) {
    return;
  }
  addUsage(parsed.session.usage, usage);
  parsed.session.inferences += 1;
  aggregateInto(
    parsed.session.models,
    state.currentModel,
    parsed.session.id,
    usage,
  );
  aggregateInto(
    parsed.session.routes,
    `${state.currentModel}/${state.currentEffort}`,
    parsed.session.id,
    usage,
  );
  aggregateInto(
    parsed.timeline,
    bucketKey(timestamp, options.bucket),
    parsed.session.id,
    usage,
  );
  readRateSnapshot(parsed.rates, payload, timestamp);
}

function readGuardianReview(session: SessionSummary, payload: unknown): void {
  session.reviewCount += 1;
  session.reviewDurationMs += asNumber(property(payload, "duration_ms"));
  const message = asString(property(payload, "last_agent_message")) ?? "{}";
  const assessment = parseJsonObject(message);
  const outcome = property(assessment, "outcome");
  if (outcome === "allow") {
    session.reviewAllow += 1;
  }
  if (outcome === "deny") {
    session.reviewDeny += 1;
  }
}

function readStructuralEvent(
  parsed: ParsedRollout,
  state: ParseState,
  eventType: unknown,
  payload: unknown,
  forkBoundary: ForkBoundary,
): boolean {
  if (eventType === "session_meta") {
    readSessionMeta(parsed.session, payload);
    return true;
  }
  if (eventType === "turn_context") {
    readTurnContext(state, payload, forkBoundary);
    return true;
  }
  return false;
}

function readTimedEventMessage(
  parsed: ParsedRollout,
  state: ParseState,
  payload: unknown,
  timestamp: number,
  options: Options,
): void {
  const payloadType = property(payload, "type");
  if (payloadType === "token_count") {
    readTokenCount(parsed, state, payload, timestamp, options);
  }
  if (parsed.session.actor === "guardian" && payloadType === "task_complete") {
    readGuardianReview(parsed.session, payload);
  }
}

export async function parseRollout(
  path: string,
  options: Options,
): Promise<ParsedRollout> {
  const forkBoundary = await findForkBoundary(path);
  const parsed: ParsedRollout = {
    session: createSession(path),
    rates: [],
    timeline: new Map(),
  };
  const state: ParseState = {
    currentModel: "unknown",
    currentEffort: "unknown",
    reachedOwnTurn: !forkBoundary.forked,
  };
  for await (const event of readEvents(path)) {
    const eventType = property(event, "type");
    const payload = property(event, "payload");
    if (readStructuralEvent(parsed, state, eventType, payload, forkBoundary)) {
      continue;
    }
    if (eventType !== "event_msg") {
      continue;
    }
    const payloadType = property(payload, "type");
    const timestampValue = asString(property(event, "timestamp"));
    const timestamp = Date.parse(timestampValue ?? "");
    if (
      !Number.isFinite(timestamp) ||
      timestamp < options.from ||
      timestamp > options.to
    ) {
      if (payloadType === "token_count") {
        updatePreviousUsage(state, payload);
      }
      continue;
    }
    readTimedEventMessage(parsed, state, payload, timestamp, options);
  }
  return parsed;
}
