import type { SerializableAggregate, UsageReport } from "./contracts.ts";

const localDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

function formatLocalDateTime(value: string): string {
  return localDateTimeFormatter.format(new Date(value));
}

function formatNumber(value: number): string {
  return value >= 1_000_000_000
    ? `${(value / 1_000_000_000).toFixed(2)}B`
    : value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(2)}M`
      : value >= 1_000
        ? `${(value / 1_000).toFixed(1)}K`
        : Math.round(value).toString();
}

function totalProxy(object: Record<string, SerializableAggregate>): number {
  return Object.values(object).reduce(
    (total, value) => total + value.comparisonProxy,
    0,
  );
}

function percent(part: number, whole: number): string {
  return whole ? `${((part / whole) * 100).toFixed(1)}%` : "0.0%";
}

function rankedRows(
  object: Record<string, SerializableAggregate>,
): [string, SerializableAggregate][] {
  return Object.entries(object).sort(
    (left, right) => right[1].comparisonProxy - left[1].comparisonProxy,
  );
}

function printTable(title: string, headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    return;
  }
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  console.log(`\n${title}`);
  console.log(
    headers.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  "),
  );
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(
      row.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  "),
    );
  }
}

function usageRow(
  name: string,
  value: SerializableAggregate,
  total: number,
): string[] {
  return [
    name,
    String(value.sessions),
    String(value.inferences),
    formatNumber(value.totalTokens),
    formatNumber(value.uncachedInputTokens),
    `${value.cachePercent.toFixed(1)}%`,
    formatNumber(value.outputTokens),
    formatNumber(value.comparisonProxy),
    percent(value.comparisonProxy, total),
  ];
}

function aggregateRows(
  aggregates: Record<string, SerializableAggregate>,
): string[][] {
  const total = totalProxy(aggregates);
  return rankedRows(aggregates).map(([name, value]) =>
    usageRow(name, value, total),
  );
}

function printAggregates(
  title: string,
  firstHeader: string,
  countHeader: "sessions" | "agents",
  aggregates: Record<string, SerializableAggregate>,
): void {
  printTable(
    title,
    [
      firstHeader,
      countHeader,
      "calls",
      "total",
      "uncached",
      "cache",
      "output",
      "proxy",
      "share",
    ],
    aggregateRows(aggregates),
  );
}

function printRateLimit(report: UsageReport): void {
  const rateLimit = report.rateLimit;
  if (!rateLimit) {
    return;
  }
  const reset = rateLimit.resetsAt
    ? formatLocalDateTime(rateLimit.resetsAt)
    : "unknown";
  const change =
    rateLimit.changePoints >= 0
      ? `+${rateLimit.changePoints}`
      : String(rateLimit.changePoints);
  console.log(
    `Weekly meter ${rateLimit.firstUsedPercent}% -> ${rateLimit.lastUsedPercent}% (${change} points) | resets ${reset}`,
  );
}

function printGuardian(report: UsageReport): void {
  const guardian = report.guardian;
  const average = guardian.averageDurationMs
    ? `${(guardian.averageDurationMs / 1000).toFixed(1)}s`
    : "n/a";
  console.log(
    `\nGuardian\n  reviews ${guardian.reviews} (${guardian.allow} allow, ${guardian.deny} deny, ${guardian.unknown} unknown) | avg ${average} | cache ${guardian.cachePercent.toFixed(1)}% | proxy ${formatNumber(guardian.comparisonProxy)}`,
  );
}

function actorProxy(
  task: UsageReport["topRootTasks"][number],
  actor: "root" | "subagent" | "guardian",
): number {
  return task.actors[actor]?.comparisonProxy ?? 0;
}

function printRootTasks(report: UsageReport): void {
  printTable(
    "Top root tasks",
    ["task", "proxy", "root", "agents", "guardian", "agent%", "id"],
    report.topRootTasks.map((task) => {
      const subagent = actorProxy(task, "subagent");
      const label =
        task.title.length <= 42 ? task.title : `${task.title.slice(0, 41)}…`;
      return [
        label,
        formatNumber(task.comparisonProxy),
        formatNumber(actorProxy(task, "root")),
        formatNumber(subagent),
        formatNumber(actorProxy(task, "guardian")),
        percent(subagent, task.comparisonProxy),
        task.id.slice(0, 8),
      ];
    }),
  );
}

function printTimeline(report: UsageReport): void {
  printTable(
    "Timeline",
    [
      report.range.bucket,
      "sessions",
      "calls",
      "total",
      "uncached",
      "cache",
      "output",
      "proxy",
      "meter",
    ],
    Object.entries(report.timeline).map(([key, value]) => [
      key,
      String(value.sessions),
      String(value.inferences),
      formatNumber(value.totalTokens),
      formatNumber(value.uncachedInputTokens),
      `${value.cachePercent.toFixed(1)}%`,
      formatNumber(value.outputTokens),
      formatNumber(value.comparisonProxy),
      value.rateLimit
        ? `${value.rateLimit.firstUsedPercent}%→${value.rateLimit.lastUsedPercent}%`
        : "n/a",
    ]),
  );
}

export function printHuman(report: UsageReport): void {
  console.log(
    `Codex usage: ${formatLocalDateTime(report.range.from)} -> ${formatLocalDateTime(report.range.to)}`,
  );
  console.log(
    `Rollouts ${report.range.rolloutFiles} | cache proxy weight ${report.range.cachedWeight}`,
  );
  printRateLimit(report);
  printAggregates("Actors", "actor", "sessions", report.actors);
  printAggregates("Models", "model", "sessions", report.models);
  if (Object.keys(report.subagentRoutes).length > 0) {
    printAggregates(
      "Subagent routes",
      "model/effort",
      "agents",
      report.subagentRoutes,
    );
  }
  if (Object.keys(report.subagentRoles).length > 0) {
    printAggregates("Subagent roles", "role", "agents", report.subagentRoles);
  }
  if (Object.keys(report.subagentTiers).length > 0) {
    printAggregates(
      "Legacy subagent tiers",
      "tier",
      "agents",
      report.subagentTiers,
    );
  }
  printGuardian(report);
  printRootTasks(report);
  printTimeline(report);
  console.log(
    "\nProxy = uncached input + cached input * weight + output. It is comparative, not billing or quota.",
  );
}

export function printJson(report: UsageReport): void {
  console.log(JSON.stringify(report, null, 2));
}
