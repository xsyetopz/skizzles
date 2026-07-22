import { createHash } from "node:crypto";
import { posix } from "node:path";
import { types } from "node:util";
import type {
  PhysicalCandidateMeasurement,
  PhysicalCandidateTarget,
  PhysicalConnection,
  PhysicalIntegrationBindings,
  PhysicalIntegrationRejection,
  PhysicalIntegrationRejectionCode,
  PhysicalProbe,
  PhysicalProbeProfile,
} from "./contract.ts";

const maximumCandidateTargets = 256;
const maximumCandidateBytes = 64 * 1024 * 1024;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const schemePattern = /^[a-z][a-z0-9+.-]*$/u;

export interface ParsedAttestationEnvelope {
  readonly declaration: object;
  readonly bindingsValue: unknown;
  readonly candidateTargetsValue: unknown;
  readonly validShape: boolean;
}

export interface ParsedDeclarationInput {
  readonly labId: string;
  readonly manifestDigest: string;
  readonly connections: readonly PhysicalConnection[];
  readonly probeProfileId: string;
}

export function parseDeclarationInput(
  input: unknown,
): ParsedDeclarationInput | undefined {
  const record = snapshotRecord(input, [
    "version",
    "kind",
    "labId",
    "manifestDigest",
    "connections",
    "probeProfileId",
  ]);
  if (
    record === undefined ||
    record.get("version") !== 1 ||
    record.get("kind") !== "physical-integration"
  )
    return;
  const labId = record.get("labId");
  const manifestDigest = record.get("manifestDigest");
  const probeProfileId = record.get("probeProfileId");
  const connections = parseConnections(record.get("connections"));
  if (
    !boundedString(labId, 128) ||
    !isDigest(manifestDigest) ||
    !boundedString(probeProfileId, 128) ||
    connections === undefined
  )
    return;
  return Object.freeze({ labId, manifestDigest, connections, probeProfileId });
}

export function parseAttestationEnvelope(
  input: unknown,
): ParsedAttestationEnvelope | undefined {
  const record = snapshotUnknownRecord(input);
  const declaration = record?.get("declaration");
  if (
    typeof declaration !== "object" ||
    declaration === null ||
    Array.isArray(declaration)
  )
    return;
  return {
    declaration,
    bindingsValue: record?.get("bindings"),
    candidateTargetsValue: record?.get("candidateTargets"),
    validShape:
      record?.size === 3 &&
      record.has("declaration") &&
      record.has("bindings") &&
      record.has("candidateTargets"),
  };
}

export function parseBindings(
  value: unknown,
): PhysicalIntegrationBindings | undefined {
  const record = snapshotRecord(value, [
    "requestDigest",
    "repositoryId",
    "treeDigest",
    "baselineDigest",
    "candidateDigest",
    "provenanceDigest",
  ]);
  const requestDigest = record?.get("requestDigest");
  const repositoryId = record?.get("repositoryId");
  const treeDigest = record?.get("treeDigest");
  const baselineDigest = record?.get("baselineDigest");
  const candidateDigest = record?.get("candidateDigest");
  const provenanceDigest = record?.get("provenanceDigest");
  if (
    !isDigest(requestDigest) ||
    !boundedString(repositoryId, 512) ||
    !isDigest(treeDigest) ||
    !isDigest(baselineDigest) ||
    !isDigest(candidateDigest) ||
    !isDigest(provenanceDigest)
  )
    return;
  return Object.freeze({
    requestDigest,
    repositoryId,
    treeDigest,
    baselineDigest,
    candidateDigest,
    provenanceDigest,
  });
}

export function parseCandidateTargets(
  value: unknown,
): readonly PhysicalCandidateTarget[] | undefined {
  try {
    return parseCandidateTargetArray(value);
  } catch {
    return;
  }
}

export function parseProbeProfiles(
  values: readonly PhysicalProbeProfile[],
): ReadonlyMap<string, PhysicalProbe> | undefined {
  if (
    !Array.isArray(values) ||
    valueIsProxy(values) ||
    values.length === 0 ||
    values.length > 64
  )
    return;
  const profiles = new Map<string, PhysicalProbe>();
  for (const value of values) {
    const profile = parseProbeProfile(value);
    if (profile === undefined || profiles.has(profile.profileId)) return;
    profiles.set(profile.profileId, profile);
  }
  return profiles;
}

export function rejected(
  code: PhysicalIntegrationRejectionCode,
): PhysicalIntegrationRejection {
  return Object.freeze({ status: "rejected", code });
}

export function digestValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function digestBytes(value: ArrayLike<number>): string {
  return `sha256:${createHash("sha256").update(Uint8Array.from(value)).digest("hex")}`;
}

export function candidateDigestOf(
  targets: readonly PhysicalCandidateMeasurement[],
): string {
  return digestValue(targets.map(({ path, digest }) => [path, digest]));
}

export function targetSetDigestOf(
  targets: readonly PhysicalCandidateMeasurement[],
): string {
  return digestValue(
    targets.map(({ path, digest, byteLength }) => [path, digest, byteLength]),
  );
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCandidateTargetArray(
  value: unknown,
): readonly PhysicalCandidateTarget[] | undefined {
  if (
    !Array.isArray(value) ||
    valueIsProxy(value) ||
    !Object.isFrozen(value) ||
    value.length === 0 ||
    value.length > maximumCandidateTargets
  )
    return;
  const targets: PhysicalCandidateTarget[] = [];
  let totalBytes = 0;
  let previousPath: string | undefined;
  for (const item of value) {
    const record = snapshotRecord(item, [
      "path",
      "digest",
      "byteLength",
      "bytes",
    ]);
    if (record === undefined || !Object.isFrozen(item)) return;
    const path = record.get("path");
    const expectedDigest = record.get("digest");
    const byteLength = record.get("byteLength");
    const bytes = parseFrozenBytes(record.get("bytes"));
    if (
      !candidatePath(path) ||
      !isDigest(expectedDigest) ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      bytes === undefined ||
      bytes.length !== byteLength ||
      digestBytes(bytes) !== expectedDigest ||
      (previousPath !== undefined && compareText(previousPath, path) >= 0)
    )
      return;
    totalBytes += bytes.length;
    if (totalBytes > maximumCandidateBytes) return;
    previousPath = path;
    targets.push(
      Object.freeze({ path, digest: expectedDigest, byteLength, bytes }),
    );
  }
  return Object.freeze(targets);
}

function parseConnections(
  value: unknown,
): readonly PhysicalConnection[] | undefined {
  if (
    !Array.isArray(value) ||
    valueIsProxy(value) ||
    value.length === 0 ||
    value.length > 64
  )
    return;
  const connections: PhysicalConnection[] = [];
  const names = new Set<string>();
  for (const candidate of value) {
    const record = snapshotRecord(candidate, [
      "name",
      "service",
      "target",
      "scheme",
    ]);
    const name = record?.get("name");
    const service = record?.get("service");
    const target = record?.get("target");
    const scheme = record?.get("scheme");
    if (
      !boundedString(name, 128) ||
      !boundedString(service, 128) ||
      typeof target !== "number" ||
      !Number.isSafeInteger(target) ||
      target < 1 ||
      target > 65_535 ||
      typeof scheme !== "string" ||
      !schemePattern.test(scheme) ||
      names.has(name)
    )
      return;
    names.add(name);
    connections.push(Object.freeze({ name, service, target, scheme }));
  }
  return Object.freeze(
    connections.sort(
      (left, right) =>
        compareText(left.name, right.name) ||
        compareText(left.service, right.service) ||
        left.target - right.target ||
        compareText(left.scheme, right.scheme),
    ),
  );
}

function parseProbeProfile(value: unknown): PhysicalProbe | undefined {
  const record = snapshotRecord(value, [
    "id",
    "version",
    "argv",
    "cwd",
    "environment",
    "timeoutSeconds",
  ]);
  const id = record?.get("id");
  const version = record?.get("version");
  const cwd = record?.get("cwd");
  const timeoutSeconds = record?.get("timeoutSeconds");
  const argv = boundedStringArray(record?.get("argv"), 256, 16_384);
  const environment = boundedEnvironment(record?.get("environment"));
  if (
    !boundedString(id, 128) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    argv === undefined ||
    !boundedString(cwd, 4096) ||
    environment === undefined ||
    typeof timeoutSeconds !== "number" ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 7200
  )
    return;
  const material = Object.freeze({
    profileId: id,
    profileVersion: version,
    argv,
    cwd,
    environment,
    timeoutSeconds,
  });
  return Object.freeze({ ...material, profileDigest: digestValue(material) });
}

function boundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemBytes: number,
): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    valueIsProxy(value) ||
    value.length === 0 ||
    value.length > maximumItems
  )
    return;
  const output: string[] = [];
  for (const item of value) {
    if (!boundedString(item, maximumItemBytes)) return;
    output.push(item);
  }
  return Object.freeze(output);
}

function boundedEnvironment(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  const record = snapshotUnknownRecord(value);
  if (record === undefined || record.size > 64) return;
  const output: Record<string, string> = {};
  for (const [name, item] of record) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || !boundedString(item, 16_384))
      return;
    output[name] = item;
  }
  return Object.freeze(output);
}

function parseFrozenBytes(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || valueIsProxy(value) || !Object.isFrozen(value))
    return;
  const output: number[] = [];
  for (const byte of value) {
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    )
      return;
    output.push(byte);
  }
  return Object.freeze(output);
}

function candidatePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  )
    return false;
  const normalized = posix.normalize(value);
  return (
    normalized === value && normalized !== ".." && !normalized.startsWith("../")
  );
}

function snapshotRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  const record = snapshotUnknownRecord(value);
  if (
    record === undefined ||
    record.size !== keys.length ||
    !keys.every((key) => record.has(key))
  )
    return;
  return record;
}

function snapshotUnknownRecord(
  value: unknown,
): ReadonlyMap<string, unknown> | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      types.isProxy(value)
    )
      return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const record = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return;
      record.set(key, descriptor.value);
    }
    return record;
  } catch {
    return;
  }
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maximumBytes
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

function valueIsProxy(value: object): boolean {
  return types.isProxy(value);
}
