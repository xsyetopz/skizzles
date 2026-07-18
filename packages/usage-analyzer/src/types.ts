export type Actor = "root" | "subagent" | "guardian" | "other";

export type Bucket = "hour" | "day";

export type Options = {
  from: number;
  to: number;
  bucket: Bucket;
  cachedWeight: number;
  top: number;
  json: boolean;
};

export type Usage = {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
  proxy: number;
};

export type Aggregate = {
  usage: Usage;
  inferences: number;
  sessions: Set<string>;
};

export type RateSnapshot = {
  timestamp: number;
  usedPercent: number;
  resetsAt?: number;
};

export type SessionSummary = {
  id: string;
  actor: Actor;
  parentId?: string;
  agentPath?: string;
  usage: Usage;
  inferences: number;
  models: Map<string, Aggregate>;
  routes: Map<string, Aggregate>;
  reviewCount: number;
  reviewAllow: number;
  reviewDeny: number;
  reviewDurationMs: number;
};

export type ParsedRollout = {
  session: SessionSummary;
  rates: RateSnapshot[];
  timeline: Map<string, Aggregate>;
};

export type SerializableUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cachePercent: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  comparisonProxy: number;
};

export type SerializableAggregate = SerializableUsage & {
  sessions: number;
  inferences: number;
};

export type RateLimitSummary = {
  firstUsedPercent: number;
  lastUsedPercent: number;
  changePoints: number;
};

export type TimelineReport = SerializableAggregate & {
  rateLimit: RateLimitSummary | null;
};

export type RootTaskReport = SerializableUsage & {
  id: string;
  title: string;
  actors: Partial<Record<Actor, SerializableAggregate>>;
};

export type UsageReport = {
  range: {
    from: string;
    to: string;
    timezone: string;
    bucket: Bucket;
    cachedWeight: number;
    rolloutFiles: number;
  };
  rateLimit: (RateLimitSummary & { resetsAt: string | null }) | null;
  actors: Record<string, SerializableAggregate>;
  models: Record<string, SerializableAggregate>;
  subagentRoutes: Record<string, SerializableAggregate>;
  subagentRoles: Record<string, SerializableAggregate>;
  subagentTiers: Record<string, SerializableAggregate>;
  guardian: SerializableUsage & {
    reviews: number;
    allow: number;
    deny: number;
    unknown: number;
    durationMs: number;
    averageDurationMs: number;
  };
  topRootTasks: RootTaskReport[];
  timeline: Record<string, TimelineReport>;
};
