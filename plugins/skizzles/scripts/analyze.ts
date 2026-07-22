#!/usr/bin/env bun
// @bun

// packages/usage-analysis/src/main.ts
import { join as join2 } from "path";
import process2 from "process";

// packages/usage-analysis/src/rollout/discovery.ts
import { Database } from "bun:sqlite";
import { join } from "path";
var rolloutIdPattern = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
var stateDatabasePattern = /state_(\d+)\.sqlite$/;
function rolloutId(path) {
  return rolloutIdPattern.exec(path)?.[1];
}
async function listRollouts(codexHome) {
  const candidates = [];
  for (const root of [
    join(codexHome, "sessions"),
    join(codexHome, "archived_sessions")
  ]) {
    try {
      for await (const relative of new Bun.Glob("**/*.jsonl").scan({
        cwd: root,
        onlyFiles: true
      })) {
        candidates.push(join(root, relative));
      }
    } catch {}
  }
  const byId = new Map;
  for (const path of candidates) {
    const id = rolloutId(path) ?? path;
    const size = Bun.file(path).size;
    const existing = byId.get(id);
    if (!existing || size > existing.size) {
      byId.set(id, { path, size });
    }
  }
  return [...byId.values()].map(({ path }) => path).sort((left, right) => left.localeCompare(right));
}
function databaseSequence(path) {
  return Number(stateDatabasePattern.exec(path)?.[1] ?? 0);
}
function loadTitles(codexHome) {
  const titles = new Map;
  try {
    const databases = [
      ...new Bun.Glob("state_*.sqlite").scanSync({
        cwd: codexHome,
        onlyFiles: true
      })
    ].sort((left, right) => databaseSequence(right) - databaseSequence(left));
    const newest = databases[0];
    if (!newest) {
      return titles;
    }
    const database = new Database(join(codexHome, newest), { readonly: true });
    try {
      const query = database.query("SELECT id, title FROM threads");
      for (const row of query.all()) {
        if (typeof row.id === "string" && typeof row.title === "string") {
          titles.set(row.id, row.title);
        }
      }
    } finally {
      database.close();
    }
  } catch {}
  return titles;
}

// packages/usage-analysis/src/rollout/parser.ts
import { basename } from "path";

// packages/usage-analysis/src/usage.ts
function asObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  return Object.fromEntries(Object.entries(value));
}
function parseJsonObject(value) {
  try {
    return asObject(JSON.parse(value));
  } catch {
    return;
  }
}
function asString(value) {
  return typeof value === "string" ? value : undefined;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function property(object, key) {
  return asObject(object)?.[key];
}
function nestedProperty(object, keys) {
  let current = object;
  for (const key of keys) {
    current = property(current, key);
  }
  return current;
}
function emptyUsage() {
  return {
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    proxy: 0
  };
}
function emptyAggregate() {
  return { usage: emptyUsage(), inferences: 0, sessions: new Set };
}
function addUsage(target, source) {
  target.input += source.input;
  target.cached += source.cached;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.total += source.total;
  target.proxy += source.proxy;
}
function usageFrom(raw, cachedWeight) {
  const input = asNumber(property(raw, "input_tokens"));
  const cached = Math.min(input, asNumber(property(raw, "cached_input_tokens")));
  const output = asNumber(property(raw, "output_tokens"));
  return {
    input,
    cached,
    output,
    reasoning: asNumber(property(raw, "reasoning_output_tokens")),
    total: asNumber(property(raw, "total_tokens")) || input + output,
    proxy: input - cached + cached * cachedWeight + output
  };
}
function usageDelta(current, previous, cachedWeight) {
  const delta = (key) => Math.max(0, asNumber(property(current, key)) - asNumber(property(previous, key)));
  return usageFrom({
    input_tokens: delta("input_tokens"),
    cached_input_tokens: delta("cached_input_tokens"),
    output_tokens: delta("output_tokens"),
    reasoning_output_tokens: delta("reasoning_output_tokens"),
    total_tokens: delta("total_tokens")
  }, cachedWeight);
}
function aggregateInto(map, key, id, usage) {
  const aggregate = map.get(key) ?? emptyAggregate();
  addUsage(aggregate.usage, usage);
  aggregate.inferences += 1;
  aggregate.sessions.add(id);
  map.set(key, aggregate);
}
function mergeAggregate(target, source) {
  addUsage(target.usage, source.usage);
  target.inferences += source.inferences;
  for (const id of source.sessions) {
    target.sessions.add(id);
  }
}
function bucketKey(timestamp, bucket) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return bucket === "hour" ? `${day} ${pad(date.getHours())}:00` : day;
}
function serializableUsage(usage) {
  return {
    inputTokens: usage.input,
    cachedInputTokens: usage.cached,
    uncachedInputTokens: usage.input - usage.cached,
    cachePercent: usage.input ? usage.cached / usage.input * 100 : 0,
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning,
    totalTokens: usage.total,
    comparisonProxy: usage.proxy
  };
}
function serializableAggregate(aggregate) {
  return {
    sessions: aggregate.sessions.size,
    inferences: aggregate.inferences,
    ...serializableUsage(aggregate.usage)
  };
}
function aggregateRecord(entries) {
  return Object.fromEntries([...entries].map(([key, value]) => [key, serializableAggregate(value)]));
}

// packages/usage-analysis/src/rollout/reader.ts
async function* lines(path) {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder;
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf(`
`);
    while (newline >= 0) {
      yield pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf(`
`);
    }
  }
  pending += decoder.decode();
  if (pending) {
    yield pending;
  }
}
function parseEvent(line) {
  if (!line.trim()) {
    return;
  }
  try {
    return asObject(JSON.parse(line));
  } catch {
    return;
  }
}
async function* readEvents(path) {
  for await (const line of lines(path)) {
    const event = parseEvent(line);
    if (event) {
      yield event;
    }
  }
}

// packages/usage-analysis/src/rollout/parser.ts
function classify(source) {
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
async function findForkBoundary(path) {
  let forked = false;
  let turnId;
  for await (const event of readEvents(path)) {
    const payload = property(event, "payload");
    if (property(event, "type") === "session_meta") {
      forked = classify(property(payload, "source")) === "subagent" && typeof property(payload, "forked_from_id") === "string";
      if (!forked) {
        return { forked: false };
      }
    }
    if (forked && property(event, "type") === "event_msg" && property(payload, "type") === "task_started") {
      turnId = asString(property(payload, "turn_id")) ?? turnId;
    }
  }
  return { forked, ...turnId ? { turnId } : {} };
}
function createSession(path) {
  return {
    id: rolloutId(path) ?? basename(path),
    actor: "other",
    usage: emptyUsage(),
    inferences: 0,
    models: new Map,
    routes: new Map,
    reviewCount: 0,
    reviewAllow: 0,
    reviewDeny: 0,
    reviewDurationMs: 0
  };
}
function readSessionMeta(session, payload) {
  session.id = asString(property(payload, "id")) ?? asString(property(payload, "session_id")) ?? session.id;
  session.actor = classify(property(payload, "source"));
  const parentId = asString(property(payload, "parent_thread_id")) ?? asString(nestedProperty(payload, [
    "source",
    "subagent",
    "thread_spawn",
    "parent_thread_id"
  ]));
  const agentPath = asString(property(payload, "agent_path")) ?? asString(nestedProperty(payload, [
    "source",
    "subagent",
    "thread_spawn",
    "agent_path"
  ]));
  if (parentId !== undefined) {
    session.parentId = parentId;
  }
  if (agentPath !== undefined) {
    session.agentPath = agentPath;
  }
}
function updatePreviousUsage(state, payload) {
  const total = nestedProperty(payload, ["info", "total_token_usage"]);
  state.previousTotal = total ?? state.previousTotal;
  if (state.previousTotal) {
    state.previousSignature = JSON.stringify(state.previousTotal);
  }
}
function readTurnContext(state, payload, forkBoundary) {
  if (forkBoundary.forked && forkBoundary.turnId !== undefined && property(payload, "turn_id") === forkBoundary.turnId) {
    state.reachedOwnTurn = true;
  }
  if (!state.reachedOwnTurn) {
    return;
  }
  state.currentModel = asString(property(payload, "model")) ?? state.currentModel;
  state.currentEffort = asString(property(payload, "effort")) ?? asString(property(payload, "reasoning_effort")) ?? state.currentEffort;
}
function readRateSnapshot(rates, payload, timestamp) {
  const primary = nestedProperty(payload, ["rate_limits", "primary"]);
  const usedPercent = property(primary, "used_percent");
  if (typeof usedPercent !== "number") {
    return;
  }
  const resetsAt = property(primary, "resets_at");
  rates.push({
    timestamp,
    usedPercent,
    ...typeof resetsAt === "number" ? { resetsAt: resetsAt * 1000 } : {}
  });
}
function readTokenCount(parsed, state, payload, timestamp, options) {
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
  const usage = rawLast ? usageFrom(rawLast, options.cachedWeight) : usageDelta(total, state.previousTotal, options.cachedWeight);
  state.previousTotal = total ?? state.previousTotal;
  if (signature !== undefined) {
    state.previousSignature = signature;
  }
  if (usage.total <= 0 && usage.input <= 0 && usage.output <= 0) {
    return;
  }
  addUsage(parsed.session.usage, usage);
  parsed.session.inferences += 1;
  aggregateInto(parsed.session.models, state.currentModel, parsed.session.id, usage);
  aggregateInto(parsed.session.routes, `${state.currentModel}/${state.currentEffort}`, parsed.session.id, usage);
  aggregateInto(parsed.timeline, bucketKey(timestamp, options.bucket), parsed.session.id, usage);
  readRateSnapshot(parsed.rates, payload, timestamp);
}
function readGuardianReview(session, payload) {
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
function readStructuralEvent(parsed, state, eventType, payload, forkBoundary) {
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
function readTimedEventMessage(parsed, state, payload, timestamp, options) {
  const payloadType = property(payload, "type");
  if (payloadType === "token_count") {
    readTokenCount(parsed, state, payload, timestamp, options);
  }
  if (parsed.session.actor === "guardian" && payloadType === "task_complete") {
    readGuardianReview(parsed.session, payload);
  }
}
async function parseRollout(path, options) {
  const forkBoundary = await findForkBoundary(path);
  const parsed = {
    session: createSession(path),
    rates: [],
    timeline: new Map
  };
  const state = {
    currentModel: "unknown",
    currentEffort: "unknown",
    reachedOwnTurn: !forkBoundary.forked
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
    if (!Number.isFinite(timestamp) || timestamp < options.from || timestamp > options.to) {
      if (payloadType === "token_count") {
        updatePreviousUsage(state, payload);
      }
      continue;
    }
    readTimedEventMessage(parsed, state, payload, timestamp, options);
  }
  return parsed;
}

// packages/usage-analysis/src/aggregation.ts
var subagentRoles = new Set([
  "triage",
  "worker",
  "designer",
  "qa",
  "review",
  "deployment"
]);
async function collectRollouts(paths, options) {
  const collection = {
    sessions: new Map,
    rates: [],
    timeline: new Map
  };
  for (let index = 0;index < paths.length; index += 8) {
    const parsed = await Promise.all(paths.slice(index, index + 8).map((path) => parseRollout(path, options)));
    for (const item of parsed) {
      collection.sessions.set(item.session.id, item.session);
      collection.rates.push(...item.rates);
      for (const [key, aggregate] of item.timeline) {
        const target = collection.timeline.get(key) ?? emptyAggregate();
        mergeAggregate(target, aggregate);
        collection.timeline.set(key, target);
      }
    }
  }
  return collection;
}
function addSessionAggregate(map, key, session) {
  const target = map.get(key) ?? emptyAggregate();
  addUsage(target.usage, session.usage);
  target.inferences += session.inferences;
  target.sessions.add(session.id);
  map.set(key, target);
}
function mergeSessionEntries(targetMap, sourceMap, sessionId) {
  for (const [key, source] of sourceMap) {
    const target = targetMap.get(key) ?? emptyAggregate();
    addUsage(target.usage, source.usage);
    target.inferences += source.inferences;
    target.sessions.add(sessionId);
    targetMap.set(key, target);
  }
}
function rootId(session, sessions) {
  let current = session;
  const visited = new Set([current.id]);
  while (current.parentId) {
    if (visited.has(current.parentId)) {
      break;
    }
    visited.add(current.parentId);
    const parent = sessions.get(current.parentId);
    if (!parent) {
      return current.parentId;
    }
    current = parent;
  }
  return current.id;
}
function subagentAttribution(agentPath) {
  const name = agentPath?.split("/").filter(Boolean).at(-1) ?? "unknown";
  const parts = name.split("__");
  const first = parts[0];
  const second = parts[1];
  const role = first !== undefined && subagentRoles.has(first) ? first : second !== undefined && subagentRoles.has(second) ? second : "unclassified";
  const tier = parts.length >= 3 && first !== undefined && second !== undefined && subagentRoles.has(second) ? first : undefined;
  return { role, ...tier === undefined ? {} : { tier } };
}
function addRootTask(rootTasks, session, sessions) {
  const root = rootId(session, sessions);
  const byActor = rootTasks.get(root) ?? new Map;
  const actor = byActor.get(session.actor) ?? emptyAggregate();
  addUsage(actor.usage, session.usage);
  actor.inferences += session.inferences;
  actor.sessions.add(session.id);
  byActor.set(session.actor, actor);
  rootTasks.set(root, byActor);
}
function createSessionAggregates() {
  return {
    actors: new Map,
    models: new Map,
    routes: new Map,
    roles: new Map,
    tiers: new Map,
    rootTasks: new Map,
    reviews: 0,
    reviewAllow: 0,
    reviewDeny: 0,
    reviewDurationMs: 0
  };
}
function addSession(target, session, sessions) {
  if (!(session.inferences || session.reviewCount)) {
    return;
  }
  addSessionAggregate(target.actors, session.actor, session);
  mergeSessionEntries(target.models, session.models, session.id);
  if (session.actor === "subagent") {
    mergeSessionEntries(target.routes, session.routes, session.id);
    const { role, tier } = subagentAttribution(session.agentPath);
    addSessionAggregate(target.roles, role, session);
    if (tier !== undefined) {
      addSessionAggregate(target.tiers, tier, session);
    }
  }
  addRootTask(target.rootTasks, session, sessions);
  target.reviews += session.reviewCount;
  target.reviewAllow += session.reviewAllow;
  target.reviewDeny += session.reviewDeny;
  target.reviewDurationMs += session.reviewDurationMs;
}
function aggregateSessions(sessions) {
  const target = createSessionAggregates();
  for (const session of sessions.values()) {
    addSession(target, session, sessions);
  }
  return target;
}
function actorRecord(byActor) {
  const actors = {};
  for (const [actor, aggregate] of byActor) {
    actors[actor] = serializableAggregate(aggregate);
  }
  return actors;
}
function rankRootTasks(rootTasks, titles, top) {
  return [...rootTasks.entries()].map(([id, byActor]) => {
    const total = emptyUsage();
    for (const aggregate of byActor.values()) {
      addUsage(total, aggregate.usage);
    }
    return {
      id,
      title: titles.get(id) ?? id,
      total,
      byActor
    };
  }).sort((left, right) => right.total.proxy - left.total.proxy).slice(0, top).map(({ id, title, total, byActor }) => ({
    id,
    title,
    ...serializableUsage(total),
    actors: actorRecord(byActor)
  }));
}
function rateLimitSummary(rates) {
  const first = rates[0];
  const last = rates.at(-1);
  if (!(first && last)) {
    return null;
  }
  return {
    firstUsedPercent: first.usedPercent,
    lastUsedPercent: last.usedPercent,
    changePoints: last.usedPercent - first.usedPercent,
    resetsAt: last.resetsAt ? new Date(last.resetsAt).toISOString() : null
  };
}
function groupRates(rates, options) {
  const byBucket = new Map;
  for (const rate of rates) {
    const key = bucketKey(rate.timestamp, options.bucket);
    const bucketRates = byBucket.get(key) ?? [];
    bucketRates.push(rate);
    byBucket.set(key, bucketRates);
  }
  return byBucket;
}
function timelineReport(timeline, ratesByBucket) {
  const report = {};
  for (const [key, aggregate] of [...timeline].sort(([left], [right]) => left.localeCompare(right))) {
    const bucketRates = ratesByBucket.get(key) ?? [];
    const first = bucketRates[0];
    const last = bucketRates.at(-1);
    report[key] = {
      ...serializableAggregate(aggregate),
      rateLimit: first && last ? {
        firstUsedPercent: first.usedPercent,
        lastUsedPercent: last.usedPercent,
        changePoints: last.usedPercent - first.usedPercent
      } : null
    };
  }
  return report;
}
async function buildReport(codexHome, paths, options) {
  const parsed = await collectRollouts(paths, options);
  const totals = aggregateSessions(parsed.sessions);
  parsed.rates.sort((left, right) => left.timestamp - right.timestamp);
  return {
    range: {
      from: new Date(options.from).toISOString(),
      to: new Date(options.to).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      bucket: options.bucket,
      cachedWeight: options.cachedWeight,
      rolloutFiles: paths.length
    },
    rateLimit: rateLimitSummary(parsed.rates),
    actors: aggregateRecord(totals.actors),
    models: aggregateRecord(totals.models),
    subagentRoutes: aggregateRecord(totals.routes),
    subagentRoles: aggregateRecord(totals.roles),
    subagentTiers: aggregateRecord(totals.tiers),
    guardian: {
      reviews: totals.reviews,
      allow: totals.reviewAllow,
      deny: totals.reviewDeny,
      unknown: totals.reviews - totals.reviewAllow - totals.reviewDeny,
      durationMs: totals.reviewDurationMs,
      averageDurationMs: totals.reviews === 0 ? 0 : totals.reviewDurationMs / totals.reviews,
      ...serializableUsage(totals.actors.get("guardian")?.usage ?? emptyUsage())
    },
    topRootTasks: rankRootTasks(totals.rootTasks, loadTitles(codexHome), options.top),
    timeline: timelineReport(parsed.timeline, groupRates(parsed.rates, options))
  };
}

// packages/usage-analysis/src/cli.ts
import process from "process";
var dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
var localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
var optionsWithValues = new Set([
  "--from",
  "--to",
  "--bucket",
  "--cached-weight",
  "--top"
]);
function parseLocalDate(match, endOfDay) {
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime();
}
function parseDate(value, endOfDay = false) {
  const dateOnly = dateOnlyPattern.exec(value);
  if (dateOnly) {
    return parseLocalDate(dateOnly, endOfDay);
  }
  const local = localDateTimePattern.exec(value);
  if (local) {
    const [, year, month, day, hour, minute, second = "0"] = local;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid date/time: ${value}`);
  }
  return timestamp;
}
function printHelp() {
  console.log(`Usage: skizzles-analyze --from <date/time> [options]

Analyze Codex rollout usage across active and archived sessions. By default,
the analyzer uses $CODEX_HOME when set, otherwise $HOME/.codex.

Options:
  --from <value>          Inclusive range start (required)
  --to <value>            Inclusive range end (default: now)
  --bucket hour|day       Timeline granularity (default: day)
  --cached-weight <0..1>  Cache-adjusted comparison weight (default: 0.1)
  --top <count>           Maximum rows in ranked tables (default: 10)
  --json                  Emit machine-readable JSON
  -h, --help              Show this help

Local forms like "2026-07-13 07:00" use the machine timezone. A date-only
--to value includes that entire local day. The comparison proxy is not quota
or billing: uncached input + cached input * weight + output.`);
}
function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
function applyOption(options, argv, index) {
  const argument = argv[index];
  if (argument === undefined) {
    return index;
  }
  if (argument === "--json") {
    options.json = true;
    return index;
  }
  if (argument === "--help" || argument === "-h") {
    printHelp();
    process.exit(0);
  }
  if (!optionsWithValues.has(argument)) {
    throw new Error(`Unknown argument: ${argument}`);
  }
  const value = readValue(argv, index, argument);
  if (argument === "--from") {
    options.from = parseDate(value);
  } else if (argument === "--to") {
    options.to = parseDate(value, true);
  } else if (argument === "--bucket") {
    if (value !== "hour" && value !== "day") {
      throw new Error("--bucket must be hour or day");
    }
    options.bucket = value;
  } else if (argument === "--cached-weight") {
    options.cachedWeight = Number(value);
  } else if (argument === "--top") {
    options.top = Number(value);
  }
  return index + 1;
}
function validateOptions(options) {
  if (options.from === undefined) {
    throw new Error("--from is required");
  }
  if (!Number.isFinite(options.cachedWeight) || options.cachedWeight < 0 || options.cachedWeight > 1) {
    throw new Error("--cached-weight must be between 0 and 1");
  }
  if (!Number.isInteger(options.top) || options.top < 1) {
    throw new Error("--top must be a positive integer");
  }
  if (options.from > options.to) {
    throw new Error("--from must not be after --to");
  }
}
function parseArgs(argv) {
  const options = {
    to: Date.now(),
    bucket: "day",
    cachedWeight: 0.1,
    top: 10,
    json: false
  };
  for (let index = 0;index < argv.length; index += 1) {
    index = applyOption(options, argv, index);
  }
  validateOptions(options);
  return options;
}

// packages/usage-analysis/src/report.ts
var localDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric"
});
function formatLocalDateTime(value) {
  return localDateTimeFormatter.format(new Date(value));
}
function formatNumber(value) {
  return value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : Math.round(value).toString();
}
function totalProxy(object) {
  return Object.values(object).reduce((total, value) => total + value.comparisonProxy, 0);
}
function percent(part, whole) {
  return whole ? `${(part / whole * 100).toFixed(1)}%` : "0.0%";
}
function rankedRows(object) {
  return Object.entries(object).sort((left, right) => right[1].comparisonProxy - left[1].comparisonProxy);
}
function printTable(title, headers, rows) {
  if (rows.length === 0) {
    return;
  }
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)));
  console.log(`
${title}`);
  console.log(headers.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(row.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  "));
  }
}
function usageRow(name, value, total) {
  return [
    name,
    String(value.sessions),
    String(value.inferences),
    formatNumber(value.totalTokens),
    formatNumber(value.uncachedInputTokens),
    `${value.cachePercent.toFixed(1)}%`,
    formatNumber(value.outputTokens),
    formatNumber(value.comparisonProxy),
    percent(value.comparisonProxy, total)
  ];
}
function aggregateRows(aggregates) {
  const total = totalProxy(aggregates);
  return rankedRows(aggregates).map(([name, value]) => usageRow(name, value, total));
}
function printAggregates(title, firstHeader, countHeader, aggregates) {
  printTable(title, [
    firstHeader,
    countHeader,
    "calls",
    "total",
    "uncached",
    "cache",
    "output",
    "proxy",
    "share"
  ], aggregateRows(aggregates));
}
function printRateLimit(report) {
  const rateLimit = report.rateLimit;
  if (!rateLimit) {
    return;
  }
  const reset = rateLimit.resetsAt ? formatLocalDateTime(rateLimit.resetsAt) : "unknown";
  const change = rateLimit.changePoints >= 0 ? `+${rateLimit.changePoints}` : String(rateLimit.changePoints);
  console.log(`Weekly meter ${rateLimit.firstUsedPercent}% -> ${rateLimit.lastUsedPercent}% (${change} points) | resets ${reset}`);
}
function printGuardian(report) {
  const guardian = report.guardian;
  const average = guardian.averageDurationMs ? `${(guardian.averageDurationMs / 1000).toFixed(1)}s` : "n/a";
  console.log(`
Guardian
  reviews ${guardian.reviews} (${guardian.allow} allow, ${guardian.deny} deny, ${guardian.unknown} unknown) | avg ${average} | cache ${guardian.cachePercent.toFixed(1)}% | proxy ${formatNumber(guardian.comparisonProxy)}`);
}
function actorProxy(task, actor) {
  return task.actors[actor]?.comparisonProxy ?? 0;
}
function printRootTasks(report) {
  printTable("Top root tasks", ["task", "proxy", "root", "agents", "guardian", "agent%", "id"], report.topRootTasks.map((task) => {
    const subagent = actorProxy(task, "subagent");
    const label = task.title.length <= 42 ? task.title : `${task.title.slice(0, 41)}\u2026`;
    return [
      label,
      formatNumber(task.comparisonProxy),
      formatNumber(actorProxy(task, "root")),
      formatNumber(subagent),
      formatNumber(actorProxy(task, "guardian")),
      percent(subagent, task.comparisonProxy),
      task.id.slice(0, 8)
    ];
  }));
}
function printTimeline(report) {
  printTable("Timeline", [
    report.range.bucket,
    "sessions",
    "calls",
    "total",
    "uncached",
    "cache",
    "output",
    "proxy",
    "meter"
  ], Object.entries(report.timeline).map(([key, value]) => [
    key,
    String(value.sessions),
    String(value.inferences),
    formatNumber(value.totalTokens),
    formatNumber(value.uncachedInputTokens),
    `${value.cachePercent.toFixed(1)}%`,
    formatNumber(value.outputTokens),
    formatNumber(value.comparisonProxy),
    value.rateLimit ? `${value.rateLimit.firstUsedPercent}%\u2192${value.rateLimit.lastUsedPercent}%` : "n/a"
  ]));
}
function printHuman(report) {
  console.log(`Codex usage: ${formatLocalDateTime(report.range.from)} -> ${formatLocalDateTime(report.range.to)}`);
  console.log(`Rollouts ${report.range.rolloutFiles} | cache proxy weight ${report.range.cachedWeight}`);
  printRateLimit(report);
  printAggregates("Actors", "actor", "sessions", report.actors);
  printAggregates("Models", "model", "sessions", report.models);
  if (Object.keys(report.subagentRoutes).length > 0) {
    printAggregates("Subagent routes", "model/effort", "agents", report.subagentRoutes);
  }
  if (Object.keys(report.subagentRoles).length > 0) {
    printAggregates("Subagent roles", "role", "agents", report.subagentRoles);
  }
  if (Object.keys(report.subagentTiers).length > 0) {
    printAggregates("Legacy subagent tiers", "tier", "agents", report.subagentTiers);
  }
  printGuardian(report);
  printRootTasks(report);
  printTimeline(report);
  console.log(`
Proxy = uncached input + cached input * weight + output. It is comparative, not billing or quota.`);
}
function printJson(report) {
  console.log(JSON.stringify(report, null, 2));
}

// packages/usage-analysis/src/routing/parsers.ts
var freeze = (value) => Object.freeze(value);
var digestPattern = /^sha256:[0-9a-f]{64}$/u;
var finite = (value, name, integer = false) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || integer && !Number.isSafeInteger(value))
    throw new Error(`${name} must be a finite non-negative ${integer ? "integer" : "number"}`);
  return value;
};
var text = (value, name) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /prompt|path|title|secret|credential|token/i.test(name))
    throw new Error(`${name} must be a bounded privacy-safe string`);
  return value;
};
var object = (value, name, allowed) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  const entries = Object.entries(value);
  if (entries.some(([key]) => !allowed.includes(key)))
    throw new Error(`${name} contains an unknown field`);
  if (entries.some(([key]) => /prompt|path|title|secret|credential|password|raw.?data/i.test(key)))
    throw new Error(`${name} contains privacy-sensitive raw data`);
  return Object.fromEntries(entries);
};
function parseRoutingCandidate(value) {
  const input = object(value, "candidate", [
    "id",
    "model",
    "reasoningEffort",
    "prior"
  ]);
  const id = text(input["id"], "candidate id");
  const model = text(input["model"], "candidate model");
  const reasoningEffort = parseEffort(input["reasoningEffort"]);
  const priorInput = input["prior"];
  let prior;
  if (priorInput !== undefined) {
    const p = object(priorInput, "candidate prior", ["aaii", "price"]);
    const result = {};
    if (p["aaii"] !== undefined)
      result.aaii = finite(p["aaii"], "prior aaii");
    if (p["price"] !== undefined)
      result.price = finite(p["price"], "prior price");
    prior = result;
  }
  return freeze({
    id,
    model,
    reasoningEffort,
    ...prior ? { prior: freeze(prior) } : {}
  });
}
function parseRoutingTaskProfile(value) {
  const input = object(value, "task profile", [
    "family",
    "complexity",
    "risk",
    "horizon",
    "topology",
    "decomposition",
    "agentCount",
    "parallelism",
    "contextStrategy",
    "roleIdentifiers"
  ]);
  const choose = (key, allowed) => {
    const item = input[key];
    if (typeof item !== "string")
      throw new Error(`invalid task ${key}`);
    const selected = allowed.find((candidate) => candidate === item);
    if (selected === undefined)
      throw new Error(`invalid task ${key}`);
    return selected;
  };
  const complexity = choose("complexity", ["low", "medium", "high"]);
  const risk = choose("risk", ["low", "medium", "high"]);
  const horizon = choose("horizon", ["short", "medium", "long"]);
  const topology = choose("topology", ["single-agent", "multi-agent"]);
  const decomposition = input["decomposition"] === undefined ? "sequential" : choose("decomposition", ["sequential", "parallel", "hybrid"]);
  const contextStrategy = input["contextStrategy"] === undefined ? "shared" : choose("contextStrategy", [
    "minimal",
    "shared",
    "duplicated",
    "isolated"
  ]);
  const agentCount = input["agentCount"] === undefined ? 1 : finite(input["agentCount"], "agentCount", true);
  const parallelism = input["parallelism"] === undefined ? 1 : finite(input["parallelism"], "parallelism", true);
  if (agentCount < 1 || parallelism < 1 || parallelism > agentCount)
    throw new Error("invalid workflow agentCount/parallelism");
  const roleIdentifiers = input["roleIdentifiers"] === undefined ? [] : input["roleIdentifiers"];
  if (!Array.isArray(roleIdentifiers) || roleIdentifiers.length > 32 || roleIdentifiers.some((role) => typeof role !== "string" || role.length === 0 || role.length > 64))
    throw new Error("invalid roleIdentifiers");
  return freeze({
    family: text(input["family"], "task family"),
    complexity: complexity === "low" || complexity === "medium" ? complexity : "high",
    risk: risk === "low" || risk === "medium" ? risk : "high",
    horizon: horizon === "short" || horizon === "medium" ? horizon : "long",
    topology,
    decomposition,
    agentCount,
    parallelism,
    contextStrategy: contextStrategy === "minimal" || contextStrategy === "shared" || contextStrategy === "duplicated" ? contextStrategy : "isolated",
    roleIdentifiers: Object.freeze([...roleIdentifiers])
  });
}
function parseUsage(value) {
  const input = object(value, "usage", [
    "inputTokens",
    "cachedInputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningTokens"
  ]);
  const inputTokens = finite(input["inputTokens"], "inputTokens", true);
  const cachedInputTokens = finite(input["cachedInputTokens"], "cachedInputTokens", true);
  if (cachedInputTokens > inputTokens) {
    throw new Error("cachedInputTokens cannot exceed inputTokens");
  }
  const uncachedInputTokens = input["uncachedInputTokens"] === undefined ? inputTokens - cachedInputTokens : finite(input["uncachedInputTokens"], "uncachedInputTokens", true);
  if (uncachedInputTokens !== inputTokens - cachedInputTokens) {
    throw new Error("uncachedInputTokens must equal inputTokens-cachedInputTokens");
  }
  return freeze({
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens: finite(input["outputTokens"], "outputTokens", true),
    reasoningTokens: finite(input["reasoningTokens"], "reasoningTokens", true)
  });
}
function parseOverhead(value) {
  const input = object(value, "overhead", [
    "accounting",
    "duplicatedContextTokens",
    "repeatedRepositoryReadTokens",
    "reprocessedToolResultTokens",
    "coordinatorTokens",
    "reviewTokens",
    "correctionTokens",
    "retryTokens",
    "failedLoopTokens",
    "escalationTokens",
    "replacementTokens"
  ]);
  if (input["accounting"] !== "external-and-disjoint-from-model-usage-v1") {
    throw new Error("overhead accounting must be disjoint from model usage");
  }
  return freeze({
    accounting: "external-and-disjoint-from-model-usage-v1",
    duplicatedContextTokens: finite(input["duplicatedContextTokens"], "duplicatedContextTokens", true),
    repeatedRepositoryReadTokens: finite(input["repeatedRepositoryReadTokens"] ?? 0, "repeatedRepositoryReadTokens", true),
    reprocessedToolResultTokens: finite(input["reprocessedToolResultTokens"] ?? 0, "reprocessedToolResultTokens", true),
    coordinatorTokens: finite(input["coordinatorTokens"], "coordinatorTokens", true),
    reviewTokens: finite(input["reviewTokens"] ?? 0, "reviewTokens", true),
    correctionTokens: finite(input["correctionTokens"] ?? 0, "correctionTokens", true),
    retryTokens: finite(input["retryTokens"], "retryTokens", true),
    failedLoopTokens: finite(input["failedLoopTokens"], "failedLoopTokens", true),
    escalationTokens: finite(input["escalationTokens"], "escalationTokens", true),
    replacementTokens: finite(input["replacementTokens"], "replacementTokens", true)
  });
}
function workflowTokens(usage, overhead) {
  if (overhead.accounting !== "external-and-disjoint-from-model-usage-v1" || usage.uncachedInputTokens !== usage.inputTokens - usage.cachedInputTokens) {
    throw new Error("invalid routing token ledger");
  }
  return usage.inputTokens + usage.outputTokens + usage.reasoningTokens + overhead.duplicatedContextTokens + overhead.repeatedRepositoryReadTokens + overhead.reprocessedToolResultTokens + overhead.coordinatorTokens + overhead.reviewTokens + overhead.correctionTokens + overhead.retryTokens + overhead.failedLoopTokens + overhead.escalationTokens + overhead.replacementTokens;
}
function parseStages(value) {
  if (value === undefined)
    throw new Error("stages are required");
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("stages must be a bounded array");
  return Object.freeze(value.map((item) => {
    const input = object(item, "stage", [
      "stage",
      "role",
      "model",
      "reasoningEffort",
      "dispatchRequestDigest",
      "usage"
    ]);
    const effort = parseEffort(input["reasoningEffort"]);
    return freeze({
      stage: text(input["stage"], "stage identifier"),
      role: text(input["role"], "stage role"),
      model: text(input["model"], "stage model"),
      reasoningEffort: effort,
      dispatchRequestDigest: parseDigest(input["dispatchRequestDigest"]),
      usage: parseUsage(input["usage"])
    });
  }));
}
function parseEffort(value) {
  const effort = value ?? "medium";
  if (effort === "none" || effort === "minimal" || effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max" || effort === "ultra") {
    return effort;
  }
  throw new Error("invalid reasoningEffort");
}
function parseAttempts(value) {
  if (value === undefined)
    throw new Error("attempts are required");
  const input = object(value, "attempts", [
    "retries",
    "failedLoops",
    "escalations",
    "replacements",
    "followUps",
    "latencyMs"
  ]);
  return freeze({
    retries: finite(input["retries"] ?? 0, "retries", true),
    failedLoops: finite(input["failedLoops"] ?? 0, "failedLoops", true),
    escalations: finite(input["escalations"] ?? 0, "escalations", true),
    replacements: finite(input["replacements"] ?? 0, "replacements", true),
    followUps: finite(input["followUps"] ?? 0, "followUps", true),
    latencyMs: finite(input["latencyMs"] ?? 0, "latencyMs")
  });
}
function parseRoutingObservation(value) {
  const input = object(value, "observation", [
    "id",
    "taskId",
    "runId",
    "runtimeReceiptDigest",
    "dispatchRequestDigests",
    "candidateId",
    "task",
    "usage",
    "overhead",
    "stages",
    "attempts",
    "firstPassCompletion",
    "terminalCompletion",
    "verification",
    "independentlyVerified",
    "assignment"
  ]);
  const assignment = object(input["assignment"], "assignment", [
    "candidateSetDigest",
    "candidateSet",
    "assignmentMethod",
    "experimentId",
    "policyRevision",
    "safetyFloor",
    "eligibilityDigest",
    "propensity",
    "seed"
  ]);
  if (typeof input["independentlyVerified"] !== "boolean")
    throw new Error("independentlyVerified must be boolean");
  const propensity = assignment["propensity"];
  if (typeof propensity !== "number" || !Number.isFinite(propensity) || propensity <= 0 || propensity > 1)
    throw new Error("propensity must be in (0,1]");
  const assignmentMethod = parseAssignmentMethod(assignment["assignmentMethod"]);
  const verification = parseVerification(input["verification"]);
  const candidateId = text(input["candidateId"], "candidate id");
  const candidateSet = parseIdentifierList(assignment["candidateSet"], "candidate set");
  if (!candidateSet.includes(candidateId)) {
    throw new Error("candidate must belong to the assigned candidate set");
  }
  const usage = parseUsage(input["usage"]);
  const stages = parseStages(input["stages"]);
  const dispatchRequestDigests = parseDigestList(input["dispatchRequestDigests"]);
  if (stages.some((stage) => !dispatchRequestDigests.includes(stage.dispatchRequestDigest))) {
    throw new Error("stage dispatch digests must join the observation");
  }
  if (!usageMatchesStages(usage, stages)) {
    throw new Error("stage usage must reconcile with observation usage");
  }
  const overhead = parseOverhead(input["overhead"]);
  const attempts = parseAttempts(input["attempts"]);
  return freeze({
    id: text(input["id"], "observation id"),
    taskId: text(input["taskId"], "task id"),
    runId: text(input["runId"], "run id"),
    runtimeReceiptDigest: parseDigest(input["runtimeReceiptDigest"]),
    dispatchRequestDigests,
    candidateId,
    task: parseRoutingTaskProfile(input["task"]),
    usage,
    overhead,
    stages,
    attempts,
    firstPassCompletion: booleanField(input, "firstPassCompletion"),
    verification,
    terminalCompletion: booleanField(input, "terminalCompletion"),
    independentlyVerified: input["independentlyVerified"],
    assignment: freeze({
      candidateSetDigest: parseDigest(assignment["candidateSetDigest"]),
      candidateSet,
      assignmentMethod,
      experimentId: text(assignment["experimentId"], "experiment id"),
      policyRevision: text(assignment["policyRevision"], "policy revision"),
      safetyFloor: text(assignment["safetyFloor"], "safety floor"),
      eligibilityDigest: parseDigest(assignment["eligibilityDigest"]),
      propensity,
      ...assignment["seed"] === undefined ? {} : { seed: text(assignment["seed"], "assignment seed") }
    })
  });
}
function usageMatchesStages(usage, stages) {
  const total = stages.reduce((sum, stage) => ({
    inputTokens: sum.inputTokens + stage.usage.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + stage.usage.cachedInputTokens,
    uncachedInputTokens: sum.uncachedInputTokens + stage.usage.uncachedInputTokens,
    outputTokens: sum.outputTokens + stage.usage.outputTokens,
    reasoningTokens: sum.reasoningTokens + stage.usage.reasoningTokens
  }), {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0
  });
  return total.inputTokens === usage.inputTokens && total.cachedInputTokens === usage.cachedInputTokens && total.uncachedInputTokens === usage.uncachedInputTokens && total.outputTokens === usage.outputTokens && total.reasoningTokens === usage.reasoningTokens;
}
function parseAssignmentMethod(value) {
  const method = value ?? "observational";
  if (method === "prior" || method === "randomized" || method === "exploration" || method === "exploitation" || method === "manual" || method === "observational") {
    return method;
  }
  throw new Error("invalid assignmentMethod");
}
function parseVerification(value) {
  if (value === undefined)
    throw new Error("verification evidence is required");
  const input = object(value, "verification", [
    "deterministicChecks",
    "runtimeSmoke",
    "independentReview",
    "rootRescue"
  ]);
  const fields = [
    "deterministicChecks",
    "runtimeSmoke",
    "independentReview",
    "rootRescue"
  ];
  if (fields.some((field) => typeof input[field] !== "boolean")) {
    throw new Error("verification stages must be boolean");
  }
  return freeze({
    deterministicChecks: booleanField(input, "deterministicChecks"),
    runtimeSmoke: booleanField(input, "runtimeSmoke"),
    independentReview: booleanField(input, "independentReview"),
    rootRescue: booleanField(input, "rootRescue")
  });
}
function booleanField(input, key) {
  const value = input[key];
  if (typeof value !== "boolean") {
    throw new Error("verification stages must be boolean");
  }
  return value;
}
function parseDigest(value) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error("candidate set digest must be a SHA-256 digest");
  }
  return value;
}
function parseDigestList(value) {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("dispatch digests must be a bounded array");
  }
  return Object.freeze(value.map((item) => parseDigest(item)));
}
function parseIdentifierList(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new Error(`${name} must be a bounded non-empty array`);
  }
  const identifiers = value.map((item) => text(item, `${name} identifier`));
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error(`${name} identifiers must be unique`);
  }
  return Object.freeze(identifiers);
}

// packages/usage-analysis/src/routing/learner.ts
var wilsonZ = 1.96;
function routingStratum(task) {
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
    [...task.roleIdentifiers ?? []].sort().join(",")
  ].join("|");
}

class RoutingLearner {
  #candidates;
  #observations = [];
  #minimumSamples;
  #minimumVerificationRate;
  constructor(candidates, options = {}) {
    if (candidates.length === 0)
      throw new Error("at least one candidate is required");
    const map = new Map;
    for (const candidate of candidates) {
      const parsed = parseRoutingCandidate(candidate);
      if (map.has(parsed.id))
        throw new Error("candidate ids must be unique");
      map.set(parsed.id, parsed);
    }
    this.#candidates = map;
    this.#minimumSamples = options.minimumSamples ?? 3;
    this.#minimumVerificationRate = options.minimumVerificationRate ?? 0.8;
    if (!Number.isInteger(this.#minimumSamples) || this.#minimumSamples < 1)
      throw new Error("minimumSamples must be a positive integer");
    if (!Number.isFinite(this.#minimumVerificationRate) || this.#minimumVerificationRate < 0 || this.#minimumVerificationRate > 1)
      throw new Error("minimumVerificationRate must be between 0 and 1");
  }
  addObservation(value) {
    const observation = parseRoutingObservation(value);
    if (!this.#candidates.has(observation.candidateId))
      throw new Error("observation candidate is not eligible");
    if (this.#observations.some((item) => item.id === observation.id))
      throw new Error("observation ids must be unique");
    if (this.#observations.some((item) => item.taskId === observation.taskId && item.runId === observation.runId))
      throw new Error("task/run observations must be unique");
    this.#observations.push(observation);
  }
  summaries(task) {
    const strata = routingStratum(task);
    return [...this.#candidates.values()].sort((a, b) => a.id.localeCompare(b.id)).map((candidate) => {
      const comparable = this.#observations.filter((item) => routingStratum(item.task) === strata && isCausalAssignment(item.assignment.assignmentMethod));
      const rows = this.#observations.filter((item) => item.candidateId === candidate.id && routingStratum(item.task) === strata && isCausalAssignment(item.assignment.assignmentMethod));
      const successes = rows.filter((item) => isVerified(item)).length;
      const workflow = rows.reduce((sum, item) => sum + workflowTokens(item.usage, item.overhead), 0);
      const verificationRate = rows.length ? successes / rows.length : 0;
      const verificationLowerBound = wilsonLowerBound(successes, rows.length);
      const attempts = rows.flatMap((item) => item.attempts === undefined ? [] : [item.attempts]);
      const coverage = comparable.length === 0 ? 0 : comparable.filter((item) => item.assignment.candidateSet.includes(candidate.id)).length / comparable.length;
      return freeze({
        candidate,
        strata,
        samples: rows.length,
        successes,
        failures: rows.length - successes,
        firstPassCompletions: rows.filter((item) => item.firstPassCompletion).length,
        verificationRate,
        verificationLowerBound,
        workflowTokens: workflow,
        expectedTokensPerSuccess: successes ? workflow / successes : null,
        candidateSetCoverage: coverage,
        meanLatencyMs: attempts.length === 0 ? 0 : attempts.reduce((sum, item) => sum + item.latencyMs, 0) / attempts.length,
        totalRetries: attempts.reduce((sum, item) => sum + item.retries, 0),
        totalEscalations: attempts.reduce((sum, item) => sum + item.escalations, 0),
        totalFollowUps: attempts.reduce((sum, item) => sum + item.followUps, 0)
      });
    });
  }
  recommend(task) {
    const eligible = this.summaries(task).filter((summary) => summary.samples >= this.#minimumSamples && summary.successes > 0 && summary.verificationLowerBound >= this.#minimumVerificationRate);
    const best = eligible.sort((a, b) => (a.expectedTokensPerSuccess ?? Number.POSITIVE_INFINITY) - (b.expectedTokensPerSuccess ?? Number.POSITIVE_INFINITY) || a.meanLatencyMs - b.meanLatencyMs || (a.candidate.prior?.price ?? Number.POSITIVE_INFINITY) - (b.candidate.prior?.price ?? Number.POSITIVE_INFINITY) || a.candidate.id.localeCompare(b.candidate.id))[0];
    return best ? freeze({
      candidate: best.candidate,
      strata: best.strata,
      reason: "empirical",
      evidence: freeze({
        samples: best.samples,
        successes: best.successes,
        candidateSetCoverage: best.candidateSetCoverage,
        verificationLowerBound: best.verificationLowerBound
      })
    }) : undefined;
  }
}
function wilsonLowerBound(successes, samples) {
  if (samples === 0)
    return 0;
  const proportion = successes / samples;
  const denominator = 1 + wilsonZ * wilsonZ / samples;
  const center = proportion + wilsonZ * wilsonZ / (2 * samples);
  const spread = wilsonZ * Math.sqrt((proportion * (1 - proportion) + wilsonZ * wilsonZ / (4 * samples)) / samples);
  return Math.max(0, (center - spread) / denominator);
}
function isVerified(item) {
  if (!item.terminalCompletion || !item.independentlyVerified)
    return false;
  const verification = item.verification;
  return verification.deterministicChecks && verification.runtimeSmoke && verification.independentReview && !verification.rootRescue;
}
function isCausalAssignment(method) {
  return method === "randomized" || method === "exploration";
}

// packages/usage-analysis/src/main.ts
async function run(argv, environment) {
  const options = parseArgs(argv);
  const codexHome = environment["CODEX_HOME"] ?? join2(environment["HOME"] ?? "", ".codex");
  const paths = await listRollouts(codexHome);
  const report = await buildReport(codexHome, paths, options);
  if (options.json) {
    printJson(report);
  } else {
    printHuman(report);
  }
}
if (import.meta.main) {
  run(Bun.argv.slice(2), process2.env).catch((error) => {
    console.error(`analyze.ts: ${error instanceof Error ? error.message : String(error)}`);
    process2.exit(1);
  });
}
export {
  workflowTokens,
  run,
  routingStratum,
  parseRoutingTaskProfile,
  parseRoutingObservation,
  parseRoutingCandidate,
  RoutingLearner
};
