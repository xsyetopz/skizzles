import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

const bytesPerKibibyte = 1024;
const maximumArgumentBytes = 32 * bytesPerKibibyte;
const maximumArguments = 256;
const maximumInvocationBytes = 256 * bytesPerKibibyte;
const maximumEnvironmentEntries = 256;
const maximumWorkingDirectoryBytes = 4096;
const maximumTimeoutMilliseconds = 3_600_000;
const maximumOutputBytes = 64 * bytesPerKibibyte * bytesPerKibibyte;
const maximumLifecycleMilliseconds = 60_000;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const arrayIndexPattern = /^(0|[1-9][0-9]*)$/u;
export const invalidSpecInvocationSha256 = createHash("sha256")
  .update("skizzles.command-supervisor/invalid-observation-spec")
  .digest("hex");

export interface CommandObservationSpec {
  readonly version: 1;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
  readonly drainMilliseconds: number;
  readonly signalGraceMilliseconds: number;
  readonly abortSignal?: AbortSignal;
}

export interface ParsedCommandObservationSpec extends CommandObservationSpec {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly abortInitially: boolean;
}

export type CommandObservationSpecParseResult =
  | Readonly<{
      kind: "valid";
      spec: ParsedCommandObservationSpec;
    }>
  | Readonly<{
      kind: "invalid";
    }>;

interface ObjectSnapshot {
  readonly values: ReadonlyMap<string, unknown>;
}

const invalidParseResult: CommandObservationSpecParseResult = Object.freeze({
  kind: "invalid",
});

function snapshotObject(
  value: unknown,
  expectedPrototypes: readonly (object | null)[],
): ObjectSnapshot | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!expectedPrototypes.includes(prototype)) {
    return;
  }
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor && "value" in descriptor)) {
      return;
    }
    values.set(key, descriptor.value);
  }
  return { values };
}

function hasExactKeys(
  snapshot: ObjectSnapshot,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const expected = new Set([...required, ...optional]);
  return (
    required.every((key) => snapshot.values.has(key)) &&
    snapshot.values.size <= expected.size &&
    [...snapshot.values.keys()].every((key) => expected.has(key))
  );
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maximumBytes
  );
}

function parseArguments(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const snapshot = snapshotObject(value, [Array.prototype]);
  const length = snapshot?.values.get("length");
  if (
    !(snapshot && isBoundedInteger(length, 1, maximumArguments)) ||
    snapshot.values.size !== length + 1
  ) {
    return;
  }
  const result: string[] = [];
  let bytes = 0;
  for (const key of snapshot.values.keys()) {
    if (key !== "length" && !arrayIndexPattern.test(key)) {
      return;
    }
  }
  for (let index = 0; index < length; index += 1) {
    const argument = snapshot.values.get(String(index));
    if (!validString(argument, maximumArgumentBytes)) {
      return;
    }
    bytes += Buffer.byteLength(argument);
    if (bytes > maximumInvocationBytes) {
      return;
    }
    result.push(argument);
  }
  if (!isAbsolute(result[0] ?? "")) {
    return;
  }
  return Object.freeze(result);
}

function parseEnvironment(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  const snapshot = snapshotObject(value, [Object.prototype, null]);
  if (!snapshot || snapshot.values.size > maximumEnvironmentEntries) {
    return;
  }
  const result: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const key of [...snapshot.values.keys()].sort()) {
    const entry = snapshot.values.get(key);
    if (
      !(
        environmentNamePattern.test(key) &&
        validString(entry, maximumArgumentBytes)
      )
    ) {
      return;
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(entry);
    if (bytes > maximumInvocationBytes) {
      return;
    }
    result[key] = entry;
  }
  return Object.freeze(result);
}

function parseAbortSignal(
  value: unknown,
): Readonly<{ signal: AbortSignal | undefined; aborted: boolean }> | undefined {
  if (value === undefined) {
    return { signal: undefined, aborted: false };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== AbortSignal.prototype ||
    Reflect.ownKeys(value).length !== 0
  ) {
    return;
  }
  const getter = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted",
  )?.get;
  if (!getter) {
    return;
  }
  const aborted = getter.call(value) as unknown;
  if (typeof aborted !== "boolean") {
    return;
  }
  return { signal: value as AbortSignal, aborted };
}

function parseSnapshot(
  snapshot: ObjectSnapshot,
): ParsedCommandObservationSpec | undefined {
  const argv = parseArguments(snapshot.values.get("argv"));
  const cwd = snapshot.values.get("cwd");
  const env = parseEnvironment(snapshot.values.get("env"));
  const abort = parseAbortSignal(snapshot.values.get("abortSignal"));
  const timeoutMilliseconds = snapshot.values.get("timeoutMilliseconds");
  const outputBytes = snapshot.values.get("maximumOutputBytes");
  const drainMilliseconds = snapshot.values.get("drainMilliseconds");
  const signalGraceMilliseconds = snapshot.values.get(
    "signalGraceMilliseconds",
  );
  if (
    snapshot.values.get("version") !== 1 ||
    !argv ||
    !validString(cwd, maximumWorkingDirectoryBytes) ||
    !isAbsolute(cwd) ||
    !env ||
    !abort ||
    !isBoundedInteger(timeoutMilliseconds, 1, maximumTimeoutMilliseconds) ||
    !isBoundedInteger(outputBytes, 1, maximumOutputBytes) ||
    !isBoundedInteger(drainMilliseconds, 0, maximumLifecycleMilliseconds) ||
    !isBoundedInteger(signalGraceMilliseconds, 0, maximumLifecycleMilliseconds)
  ) {
    return;
  }
  const parsed = {
    version: 1 as const,
    argv,
    cwd,
    env,
    timeoutMilliseconds,
    maximumOutputBytes: outputBytes,
    drainMilliseconds,
    signalGraceMilliseconds,
    abortInitially: abort.aborted,
    ...(abort.signal ? { abortSignal: abort.signal } : {}),
  };
  return Object.freeze(parsed);
}

export function parseCommandObservationSpec(
  value: unknown,
): CommandObservationSpecParseResult {
  try {
    const snapshot = snapshotObject(value, [Object.prototype, null]);
    if (
      !(
        snapshot &&
        hasExactKeys(
          snapshot,
          [
            "argv",
            "cwd",
            "drainMilliseconds",
            "env",
            "maximumOutputBytes",
            "signalGraceMilliseconds",
            "timeoutMilliseconds",
            "version",
          ],
          ["abortSignal"],
        )
      )
    ) {
      return invalidParseResult;
    }
    const spec = parseSnapshot(snapshot);
    if (!spec) {
      return invalidParseResult;
    }
    return Object.freeze({ kind: "valid", spec });
  } catch {
    return invalidParseResult;
  }
}

export function invocationDigest(spec: ParsedCommandObservationSpec): string {
  const environment = Object.keys(spec.env)
    .sort()
    .map((name) => [name, spec.env[name]] as const);
  const canonical = JSON.stringify({
    version: spec.version,
    argv: spec.argv,
    cwd: spec.cwd,
    env: environment,
    timeoutMilliseconds: spec.timeoutMilliseconds,
    maximumOutputBytes: spec.maximumOutputBytes,
    drainMilliseconds: spec.drainMilliseconds,
    signalGraceMilliseconds: spec.signalGraceMilliseconds,
    abortable: spec.abortSignal !== undefined,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
