import { loadTitles } from "./rollout-discovery.ts";
import { parseRollout } from "./rollout-parser.ts";
import type {
  Actor,
  Aggregate,
  Options,
  RateSnapshot,
  RootTaskReport,
  SessionSummary,
  TimelineReport,
  UsageReport,
} from "./types.ts";
import {
  addUsage,
  aggregateRecord,
  bucketKey,
  emptyAggregate,
  emptyUsage,
  mergeAggregate,
  serializableAggregate,
  serializableUsage,
} from "./usage.ts";

const subagentRoles = new Set([
  "triage",
  "worker",
  "designer",
  "qa",
  "review",
  "deployment",
]);

type ParsedCollection = {
  sessions: Map<string, SessionSummary>;
  rates: RateSnapshot[];
  timeline: Map<string, Aggregate>;
};

type SessionAggregates = {
  actors: Map<string, Aggregate>;
  models: Map<string, Aggregate>;
  routes: Map<string, Aggregate>;
  roles: Map<string, Aggregate>;
  tiers: Map<string, Aggregate>;
  rootTasks: Map<string, Map<Actor, Aggregate>>;
  reviews: number;
  reviewAllow: number;
  reviewDeny: number;
  reviewDurationMs: number;
};

async function collectRollouts(
  paths: string[],
  options: Options,
): Promise<ParsedCollection> {
  const collection: ParsedCollection = {
    sessions: new Map(),
    rates: [],
    timeline: new Map(),
  };
  for (let index = 0; index < paths.length; index += 8) {
    const parsed = await Promise.all(
      paths.slice(index, index + 8).map((path) => parseRollout(path, options)),
    );
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

function addSessionAggregate(
  map: Map<string, Aggregate>,
  key: string,
  session: SessionSummary,
): void {
  const target = map.get(key) ?? emptyAggregate();
  addUsage(target.usage, session.usage);
  target.inferences += session.inferences;
  target.sessions.add(session.id);
  map.set(key, target);
}

function mergeSessionEntries(
  targetMap: Map<string, Aggregate>,
  sourceMap: Map<string, Aggregate>,
  sessionId: string,
): void {
  for (const [key, source] of sourceMap) {
    const target = targetMap.get(key) ?? emptyAggregate();
    addUsage(target.usage, source.usage);
    target.inferences += source.inferences;
    target.sessions.add(sessionId);
    targetMap.set(key, target);
  }
}

function rootId(
  session: SessionSummary,
  sessions: Map<string, SessionSummary>,
): string {
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

function subagentAttribution(agentPath: string | undefined): {
  role: string;
  tier?: string;
} {
  const name = agentPath?.split("/").filter(Boolean).at(-1) ?? "unknown";
  const parts = name.split("__");
  const first = parts[0];
  const second = parts[1];
  const role =
    first !== undefined && subagentRoles.has(first)
      ? first
      : second !== undefined && subagentRoles.has(second)
        ? second
        : "unclassified";
  const tier =
    parts.length >= 3 &&
    first !== undefined &&
    second !== undefined &&
    subagentRoles.has(second)
      ? first
      : undefined;
  return { role, ...(tier === undefined ? {} : { tier }) };
}

function addRootTask(
  rootTasks: Map<string, Map<Actor, Aggregate>>,
  session: SessionSummary,
  sessions: Map<string, SessionSummary>,
): void {
  const root = rootId(session, sessions);
  const byActor = rootTasks.get(root) ?? new Map<Actor, Aggregate>();
  const actor = byActor.get(session.actor) ?? emptyAggregate();
  addUsage(actor.usage, session.usage);
  actor.inferences += session.inferences;
  actor.sessions.add(session.id);
  byActor.set(session.actor, actor);
  rootTasks.set(root, byActor);
}

function createSessionAggregates(): SessionAggregates {
  return {
    actors: new Map(),
    models: new Map(),
    routes: new Map(),
    roles: new Map(),
    tiers: new Map(),
    rootTasks: new Map(),
    reviews: 0,
    reviewAllow: 0,
    reviewDeny: 0,
    reviewDurationMs: 0,
  };
}

function addSession(
  target: SessionAggregates,
  session: SessionSummary,
  sessions: Map<string, SessionSummary>,
): void {
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

function aggregateSessions(
  sessions: Map<string, SessionSummary>,
): SessionAggregates {
  const target = createSessionAggregates();
  for (const session of sessions.values()) {
    addSession(target, session, sessions);
  }
  return target;
}

function actorRecord(
  byActor: Map<Actor, Aggregate>,
): Partial<Record<Actor, ReturnType<typeof serializableAggregate>>> {
  const actors: Partial<
    Record<Actor, ReturnType<typeof serializableAggregate>>
  > = {};
  for (const [actor, aggregate] of byActor) {
    actors[actor] = serializableAggregate(aggregate);
  }
  return actors;
}

function rankRootTasks(
  rootTasks: Map<string, Map<Actor, Aggregate>>,
  titles: Map<string, string>,
  top: number,
): RootTaskReport[] {
  return [...rootTasks.entries()]
    .map(([id, byActor]) => {
      const total = emptyUsage();
      for (const aggregate of byActor.values()) {
        addUsage(total, aggregate.usage);
      }
      return {
        id,
        title: titles.get(id) ?? id,
        total,
        byActor,
      };
    })
    .sort((left, right) => right.total.proxy - left.total.proxy)
    .slice(0, top)
    .map(({ id, title, total, byActor }) => ({
      id,
      title,
      ...serializableUsage(total),
      actors: actorRecord(byActor),
    }));
}

function rateLimitSummary(rates: RateSnapshot[]): UsageReport["rateLimit"] {
  const first = rates[0];
  const last = rates.at(-1);
  if (!(first && last)) {
    return null;
  }
  return {
    firstUsedPercent: first.usedPercent,
    lastUsedPercent: last.usedPercent,
    changePoints: last.usedPercent - first.usedPercent,
    resetsAt: last.resetsAt ? new Date(last.resetsAt).toISOString() : null,
  };
}

function groupRates(
  rates: RateSnapshot[],
  options: Options,
): Map<string, RateSnapshot[]> {
  const byBucket = new Map<string, RateSnapshot[]>();
  for (const rate of rates) {
    const key = bucketKey(rate.timestamp, options.bucket);
    const bucketRates = byBucket.get(key) ?? [];
    bucketRates.push(rate);
    byBucket.set(key, bucketRates);
  }
  return byBucket;
}

function timelineReport(
  timeline: Map<string, Aggregate>,
  ratesByBucket: Map<string, RateSnapshot[]>,
): Record<string, TimelineReport> {
  const report: Record<string, TimelineReport> = {};
  for (const [key, aggregate] of [...timeline].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const bucketRates = ratesByBucket.get(key) ?? [];
    const first = bucketRates[0];
    const last = bucketRates.at(-1);
    report[key] = {
      ...serializableAggregate(aggregate),
      rateLimit:
        first && last
          ? {
              firstUsedPercent: first.usedPercent,
              lastUsedPercent: last.usedPercent,
              changePoints: last.usedPercent - first.usedPercent,
            }
          : null,
    };
  }
  return report;
}

export async function buildReport(
  codexHome: string,
  paths: string[],
  options: Options,
): Promise<UsageReport> {
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
      rolloutFiles: paths.length,
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
      averageDurationMs:
        totals.reviews === 0 ? 0 : totals.reviewDurationMs / totals.reviews,
      ...serializableUsage(
        totals.actors.get("guardian")?.usage ?? emptyUsage(),
      ),
    },
    topRootTasks: rankRootTasks(
      totals.rootTasks,
      loadTitles(codexHome),
      options.top,
    ),
    timeline: timelineReport(
      parsed.timeline,
      groupRates(parsed.rates, options),
    ),
  };
}
