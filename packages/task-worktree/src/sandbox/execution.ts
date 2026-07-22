import { dirname, isAbsolute, normalize } from "node:path";
import { hasOnlyKeys, isPlainDataRecord } from "../policy/value.ts";
import type {
  SandboxExecutionLimits,
  SandboxExecutionReceipt,
} from "./contract.ts";

const maximumTimeoutMilliseconds = 3_600_000;
const maximumOutputBytes = 64 * 1024 * 1024;
const maximumDrainMilliseconds = 60_000;
const maximumSignalGraceMilliseconds = 60_000;

export function parseBoundRoot(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096)
    return null;
  if (value.includes("\0") || !isAbsolute(value) || normalize(value) !== value)
    return null;
  return value;
}

export function rootsAreOwnedSiblings(
  worktreeRoot: string,
  writeRoot: string,
): boolean {
  return (
    worktreeRoot !== writeRoot && dirname(worktreeRoot) === dirname(writeRoot)
  );
}

export function parseExecutionOutcome(
  value: unknown,
  bindingDigest: string,
  limits: SandboxExecutionLimits,
): Omit<SandboxExecutionReceipt, "attestationDigest" | "outcomeDigest"> | null {
  if (
    !isPlainDataRecord(value) ||
    !hasOnlyKeys(value, [
      "bindingDigest",
      "exitCode",
      "stdoutDigest",
      "stderrDigest",
      "stdoutBytes",
      "stderrBytes",
      "timeoutMilliseconds",
      "maximumOutputBytes",
      "drainMilliseconds",
      "signalGraceMilliseconds",
    ]) ||
    value["bindingDigest"] !== bindingDigest ||
    typeof value["exitCode"] !== "number" ||
    !Number.isInteger(value["exitCode"]) ||
    value["exitCode"] < 0 ||
    value["exitCode"] > 255 ||
    typeof value["stdoutDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["stdoutDigest"]) ||
    typeof value["stderrDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["stderrDigest"]) ||
    typeof value["stdoutBytes"] !== "number" ||
    !Number.isInteger(value["stdoutBytes"]) ||
    value["stdoutBytes"] < 0 ||
    value["stdoutBytes"] > limits.maximumOutputBytes ||
    typeof value["stderrBytes"] !== "number" ||
    !Number.isInteger(value["stderrBytes"]) ||
    value["stderrBytes"] < 0 ||
    value["stderrBytes"] > limits.maximumOutputBytes
  )
    return null;
  if (!optionalEchoedLimitsMatch(value, limits)) return null;
  return Object.freeze({
    bindingDigest,
    exitCode: value["exitCode"],
    stdoutDigest: value["stdoutDigest"],
    stderrDigest: value["stderrDigest"],
    stdoutBytes: value["stdoutBytes"],
    stderrBytes: value["stderrBytes"],
    ...limits,
  });
}

function optionalEchoedLimitsMatch(
  value: Record<string, unknown>,
  limits: SandboxExecutionLimits,
): boolean {
  const keys = [
    "timeoutMilliseconds",
    "maximumOutputBytes",
    "drainMilliseconds",
    "signalGraceMilliseconds",
  ] as const;
  const present = keys.filter((key) => Object.hasOwn(value, key));
  return (
    present.length === 0 ||
    (present.length === keys.length &&
      keys.every((key) => value[key] === limits[key]))
  );
}

export function parseExecutionLimits(
  value: Record<string, unknown>,
): SandboxExecutionLimits | null {
  const timeoutMilliseconds = positiveInteger(
    value["timeoutMilliseconds"],
    maximumTimeoutMilliseconds,
  );
  const maximumOutput = positiveInteger(
    value["maximumOutputBytes"],
    maximumOutputBytes,
  );
  const drainMilliseconds = nonnegativeInteger(
    value["drainMilliseconds"],
    maximumDrainMilliseconds,
  );
  const signalGraceMilliseconds = nonnegativeInteger(
    value["signalGraceMilliseconds"],
    maximumSignalGraceMilliseconds,
  );
  if (
    timeoutMilliseconds === undefined ||
    maximumOutput === undefined ||
    drainMilliseconds === undefined ||
    signalGraceMilliseconds === undefined
  )
    return null;
  return Object.freeze({
    timeoutMilliseconds,
    maximumOutputBytes: maximumOutput,
    drainMilliseconds,
    signalGraceMilliseconds,
  });
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
    ? value
    : undefined;
}

function nonnegativeInteger(
  value: unknown,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : undefined;
}
