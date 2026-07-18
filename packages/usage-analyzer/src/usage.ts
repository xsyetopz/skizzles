import type {
  Aggregate,
  Bucket,
  SerializableAggregate,
  SerializableUsage,
  Usage,
} from "./types.ts";

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

export function parseJsonObject(value: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function property(object: unknown, key: string): unknown {
  return asObject(object)?.[key];
}

export function nestedProperty(object: unknown, keys: string[]): unknown {
  let current = object;
  for (const key of keys) {
    current = property(current, key);
  }
  return current;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    proxy: 0,
  };
}

export function emptyAggregate(): Aggregate {
  return { usage: emptyUsage(), inferences: 0, sessions: new Set() };
}

export function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.cached += source.cached;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.total += source.total;
  target.proxy += source.proxy;
}

export function usageFrom(raw: unknown, cachedWeight: number): Usage {
  const input = asNumber(property(raw, "input_tokens"));
  const cached = Math.min(
    input,
    asNumber(property(raw, "cached_input_tokens")),
  );
  const output = asNumber(property(raw, "output_tokens"));
  return {
    input,
    cached,
    output,
    reasoning: asNumber(property(raw, "reasoning_output_tokens")),
    total: asNumber(property(raw, "total_tokens")) || input + output,
    proxy: input - cached + cached * cachedWeight + output,
  };
}

export function usageDelta(
  current: unknown,
  previous: unknown,
  cachedWeight: number,
): Usage {
  const delta = (key: string): number =>
    Math.max(
      0,
      asNumber(property(current, key)) - asNumber(property(previous, key)),
    );
  return usageFrom(
    {
      input_tokens: delta("input_tokens"),
      cached_input_tokens: delta("cached_input_tokens"),
      output_tokens: delta("output_tokens"),
      reasoning_output_tokens: delta("reasoning_output_tokens"),
      total_tokens: delta("total_tokens"),
    },
    cachedWeight,
  );
}

export function aggregateInto(
  map: Map<string, Aggregate>,
  key: string,
  id: string,
  usage: Usage,
): void {
  const aggregate = map.get(key) ?? emptyAggregate();
  addUsage(aggregate.usage, usage);
  aggregate.inferences += 1;
  aggregate.sessions.add(id);
  map.set(key, aggregate);
}

export function mergeAggregate(target: Aggregate, source: Aggregate): void {
  addUsage(target.usage, source.usage);
  target.inferences += source.inferences;
  for (const id of source.sessions) {
    target.sessions.add(id);
  }
}

export function bucketKey(timestamp: number, bucket: Bucket): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return bucket === "hour" ? `${day} ${pad(date.getHours())}:00` : day;
}

export function serializableUsage(usage: Usage): SerializableUsage {
  return {
    inputTokens: usage.input,
    cachedInputTokens: usage.cached,
    uncachedInputTokens: usage.input - usage.cached,
    cachePercent: usage.input ? (usage.cached / usage.input) * 100 : 0,
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning,
    totalTokens: usage.total,
    comparisonProxy: usage.proxy,
  };
}

export function serializableAggregate(
  aggregate: Aggregate,
): SerializableAggregate {
  return {
    sessions: aggregate.sessions.size,
    inferences: aggregate.inferences,
    ...serializableUsage(aggregate.usage),
  };
}

export function aggregateRecord(
  entries: Map<string, Aggregate>,
): Record<string, SerializableAggregate> {
  return Object.fromEntries(
    [...entries].map(([key, value]) => [key, serializableAggregate(value)]),
  );
}
