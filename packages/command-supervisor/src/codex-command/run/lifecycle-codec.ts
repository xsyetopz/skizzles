import type { RunStatus } from "./status.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactLifecycleKeys(value: Record<string, unknown>): boolean {
  const expected = [
    "cancellationSignal",
    "cleanup",
    "completedAt",
    "drain",
    "exitCode",
    "startedAt",
    "state",
  ];
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    expected.every((key, index) => key === actual[index])
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function runningLifecycle(
  startedAt: string,
  completedAt: unknown,
  exitCode: unknown,
  cancellationSignal: unknown,
  drain: unknown,
  cleanup: unknown,
): RunStatus["lifecycle"] | undefined {
  if (
    completedAt !== null ||
    exitCode !== null ||
    cancellationSignal !== null ||
    drain !== "pending" ||
    cleanup !== "pending"
  ) {
    return undefined;
  }
  return {
    state: "running",
    startedAt,
    completedAt,
    exitCode,
    cancellationSignal,
    drain,
    cleanup,
  };
}

function terminalLifecycle(
  state: unknown,
  startedAt: string,
  completedAt: string,
  exitCode: number,
  cancellationSignal: RunStatus["lifecycle"]["cancellationSignal"],
  drain: unknown,
  cleanup: RunStatus["lifecycle"]["cleanup"],
): RunStatus["lifecycle"] | undefined {
  if (completedAt < startedAt) {
    return undefined;
  }
  if (state === "failed-to-start") {
    if (
      exitCode !== 127 ||
      cancellationSignal !== null ||
      drain !== "complete" ||
      cleanup !== "not-required"
    ) {
      return undefined;
    }
    return {
      state,
      startedAt,
      completedAt,
      exitCode,
      cancellationSignal,
      drain,
      cleanup,
    };
  }
  if (
    state !== "completed" ||
    (drain !== "complete" && drain !== "incomplete") ||
    cleanup === "pending" ||
    (cancellationSignal !== null && cleanup === "not-required")
  ) {
    return undefined;
  }
  return {
    state,
    startedAt,
    completedAt,
    exitCode,
    cancellationSignal,
    drain,
    cleanup,
  };
}

export function parseRunLifecycle(
  value: unknown,
): RunStatus["lifecycle"] | undefined {
  if (
    !isRecord(value) ||
    !hasExactLifecycleKeys(value) ||
    !isIsoTimestamp(value["startedAt"])
  ) {
    return undefined;
  }
  const state = value["state"];
  const completedAt = value["completedAt"];
  const exitCode = value["exitCode"];
  const cancellationSignal = value["cancellationSignal"];
  const drain = value["drain"];
  const cleanup = value["cleanup"];
  const validSignal =
    cancellationSignal === null ||
    cancellationSignal === "SIGHUP" ||
    cancellationSignal === "SIGINT" ||
    cancellationSignal === "SIGTERM";
  const validCleanup =
    cleanup === "pending" ||
    cleanup === "not-required" ||
    cleanup === "terminated" ||
    cleanup === "killed";
  if (!(validSignal && validCleanup)) {
    return undefined;
  }
  if (state === "running") {
    return runningLifecycle(
      value["startedAt"],
      completedAt,
      exitCode,
      cancellationSignal,
      drain,
      cleanup,
    );
  }
  if (!(isIsoTimestamp(completedAt) && isSafeInteger(exitCode))) {
    return undefined;
  }
  return terminalLifecycle(
    state,
    value["startedAt"],
    completedAt,
    exitCode,
    cancellationSignal,
    drain,
    cleanup,
  );
}
