import { types } from "node:util";
import type { TaskWorktreeConfig } from "../../contract.ts";
import { isSafeRelativePath } from "../../policy/value.ts";
import { authorizeStructuredCommand } from "../../sandbox/command-policy.ts";

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;

export function parseVerificationProfiles(
  value: unknown,
): TaskWorktreeConfig["verificationProfiles"] | undefined {
  if (!(Array.isArray(value) && Object.isFrozen(value)) || value.length > 64)
    return;
  const profiles: TaskWorktreeConfig["verificationProfiles"][number][] = [];
  const ids = new Set<string>();
  const artifactPaths = new Set<string>();
  for (const raw of value) {
    const record = exactRecord(raw, [
      "arguments",
      "artifact",
      "cwd",
      "drainMilliseconds",
      "executable",
      "id",
      "kind",
      "maximumOutputBytes",
      "profile",
      "signalGraceMilliseconds",
      "timeoutMilliseconds",
      "view",
    ]);
    const id = record?.get("id");
    const kind = record?.get("kind");
    const view = record?.get("view");
    const command =
      record === undefined
        ? undefined
        : authorizeStructuredCommand(
            Object.freeze({
              profile: record.get("profile"),
              executable: record.get("executable"),
              arguments: record.get("arguments"),
              cwd: record.get("cwd"),
            }),
          );
    const timeoutMilliseconds = positiveInteger(
      record?.get("timeoutMilliseconds"),
      3_600_000,
    );
    const maximumOutputBytes = positiveInteger(
      record?.get("maximumOutputBytes"),
      64 * 1024 * 1024,
    );
    const drainMilliseconds = nonnegativeInteger(
      record?.get("drainMilliseconds"),
      60_000,
    );
    const signalGraceMilliseconds = nonnegativeInteger(
      record?.get("signalGraceMilliseconds"),
      60_000,
    );
    const artifact = parseArtifact(record?.get("artifact"));
    if (
      record === undefined ||
      !Object.isFrozen(raw) ||
      !identity(id) ||
      ids.has(id) ||
      (kind !== "coverage" &&
        kind !== "mutation" &&
        kind !== "original-tests" &&
        kind !== "property") ||
      (view !== "baseline-tests" && view !== "candidate") ||
      (kind === "original-tests" && view !== "baseline-tests") ||
      command?.status !== "accepted" ||
      timeoutMilliseconds === undefined ||
      maximumOutputBytes === undefined ||
      drainMilliseconds === undefined ||
      signalGraceMilliseconds === undefined ||
      artifact === undefined ||
      artifactPaths.has(artifact.relativePath.toLowerCase())
    )
      return;
    ids.add(id);
    artifactPaths.add(artifact.relativePath.toLowerCase());
    profiles.push(
      Object.freeze({
        id,
        kind,
        view,
        ...command.command,
        timeoutMilliseconds,
        maximumOutputBytes,
        drainMilliseconds,
        signalGraceMilliseconds,
        artifact,
      }),
    );
  }
  return Object.freeze(profiles);
}

function parseArtifact(
  value: unknown,
): TaskWorktreeConfig["verificationProfiles"][number]["artifact"] | undefined {
  const record = exactRecord(value, ["maximumBytes", "relativePath", "schema"]);
  const maximumBytes = positiveInteger(
    record?.get("maximumBytes"),
    16 * 1024 * 1024,
  );
  const relativePath = record?.get("relativePath");
  const schema = record?.get("schema");
  if (
    record === undefined ||
    !Object.isFrozen(value) ||
    maximumBytes === undefined ||
    typeof relativePath !== "string" ||
    !relativePath.startsWith("verification/") ||
    !relativePath.endsWith(".json") ||
    !isSafeRelativePath(relativePath) ||
    typeof schema !== "string" ||
    !identity(schema)
  )
    return;
  return Object.freeze({ maximumBytes, relativePath, schema });
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    return;
  const values = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    values.set(key, descriptor.value);
  }
  return values;
}

function identity(value: unknown): value is string {
  return typeof value === "string" && identityPattern.test(value);
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
