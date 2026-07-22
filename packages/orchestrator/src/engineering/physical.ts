import { type Digest, digestValue } from "../digest.ts";
import {
  isFrozenOpaque,
  snapshotArray,
  snapshotRecord,
} from "./session/snapshot.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumEntries = 256;
const authenticReceipts = new WeakSet<object>();
const workspaceIdentityField = ["workspace", "IdentityDigest"].join("");
const provenanceMeasurementField = ["provenance", "MeasurementDigest"].join("");

export interface PhysicalIntegrationAuthorityPort {
  readonly attest: (input: unknown) => unknown | Promise<unknown>;
}

export interface PhysicalIntegrationBindings {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
  readonly candidateDigest: Digest;
  readonly provenanceDigest: Digest;
}

export interface PhysicalIntegrationReceipt {
  readonly version: 1;
  readonly receiptDigest: Digest;
  readonly declarationDigest: Digest;
  readonly bindings: PhysicalIntegrationBindings;
  readonly owner: string;
  readonly ownerKey: string;
  readonly labId: string;
  readonly composeProject: string;
  readonly sourceRepositoryIdentity: string;
  readonly manifestPath: string;
  readonly manifestDigest: Digest;
  readonly readyState: "ready";
  readonly connections: readonly PhysicalConnection[];
  readonly endpoints: readonly PhysicalEndpoint[];
  readonly candidate: PhysicalCandidateEvidence;
  readonly probe: PhysicalProbeEvidence;
  readonly cleanup: {
    readonly destroyReported: true;
    readonly labAbsent: true;
    readonly terminal: true;
  };
}

export interface PhysicalCandidateTarget {
  readonly path: string;
  readonly digest: Digest;
  readonly byteLength: number;
  readonly bytes: readonly number[];
}

export interface PhysicalCandidateEvidence {
  readonly targetSetDigest: Digest;
  readonly candidateDigest: Digest;
  readonly workspaceIdentityDigest: Digest;
  readonly provenanceMeasurementDigest: Digest;
  readonly targets: readonly Omit<PhysicalCandidateTarget, "bytes">[];
}

interface PhysicalConnection {
  readonly name: string;
  readonly service: string;
  readonly target: number;
  readonly scheme: string;
}

interface PhysicalEndpoint {
  readonly name: string;
  readonly service: string;
  readonly target: number;
  readonly url: string;
}

interface PhysicalProbeEvidence {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileDigest: Digest;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environmentNames: readonly string[];
  readonly exitCode: number;
  readonly stdoutBytes: number;
  readonly stdoutDigest: Digest;
  readonly stderrBytes: number;
  readonly stderrDigest: Digest;
  readonly complete: true;
}

export type PhysicalAttestationResult =
  | {
      readonly status: "accepted";
      readonly receipt: PhysicalIntegrationReceipt;
    }
  | { readonly status: "rejected"; readonly code: "INTEGRATION_REJECTED" };

export async function attestPhysicalIntegration(
  authority: PhysicalIntegrationAuthorityPort,
  declaration: unknown,
  bindings: PhysicalIntegrationBindings,
  candidateTargets: readonly PhysicalCandidateTarget[],
): Promise<PhysicalAttestationResult> {
  let raw: unknown;
  try {
    raw = await authority.attest(
      Object.freeze({ declaration, bindings, candidateTargets }),
    );
  } catch {
    return rejected();
  }
  const result = snapshotRecord(raw, ["status", "receipt"]);
  if (result === undefined || result["status"] !== "accepted") {
    return rejected();
  }
  const receipt = parseReceipt(result["receipt"], bindings, candidateTargets);
  return receipt === undefined ||
    receipt.declarationDigest !== declarationDigestOf(declaration)
    ? rejected()
    : { status: "accepted", receipt };
}

function parseReceipt(
  value: unknown,
  bindings: PhysicalIntegrationBindings,
  candidateTargets: readonly PhysicalCandidateTarget[],
): PhysicalIntegrationReceipt | undefined {
  const receipt = snapshotRecord(value, [
    "version",
    "receiptDigest",
    "declarationDigest",
    "bindings",
    "owner",
    "ownerKey",
    "labId",
    "composeProject",
    "sourceRepositoryIdentity",
    "manifestPath",
    "manifestDigest",
    "readyState",
    "connections",
    "endpoints",
    "candidate",
    "probe",
    "cleanup",
  ]);
  if (
    !(
      receipt !== undefined &&
      receipt["version"] === 1 &&
      validDigest(receipt["receiptDigest"]) &&
      validDigest(receipt["declarationDigest"]) &&
      sameBindings(receipt["bindings"], bindings) &&
      validIdentity(receipt["owner"]) &&
      validIdentity(receipt["ownerKey"]) &&
      validIdentity(receipt["labId"]) &&
      validIdentity(receipt["composeProject"]) &&
      validIdentity(receipt["sourceRepositoryIdentity"]) &&
      validIdentity(receipt["manifestPath"]) &&
      validDigest(receipt["manifestDigest"]) &&
      receipt["readyState"] === "ready"
    )
  ) {
    return;
  }
  const connections = parseConnections(receipt["connections"]);
  const endpoints = parseEndpoints(receipt["endpoints"]);
  const probe = parseProbe(receipt["probe"]);
  const candidate = parseCandidateEvidence(
    receipt["candidate"],
    receipt["declarationDigest"],
    receipt["manifestDigest"],
    probe?.profileDigest,
    bindings,
    candidateTargets,
  );
  const cleanup = parseCleanup(receipt["cleanup"]);
  if (
    connections === undefined ||
    endpoints === undefined ||
    !sameEndpoints(connections, endpoints) ||
    candidate === undefined ||
    probe === undefined ||
    cleanup === undefined
  ) {
    return;
  }
  const material = Object.freeze({
    version: 1 as const,
    declarationDigest: receipt["declarationDigest"],
    bindings,
    owner: receipt["owner"],
    ownerKey: receipt["ownerKey"],
    labId: receipt["labId"],
    composeProject: receipt["composeProject"],
    sourceRepositoryIdentity: receipt["sourceRepositoryIdentity"],
    manifestPath: receipt["manifestPath"],
    manifestDigest: receipt["manifestDigest"],
    readyState: "ready" as const,
    connections,
    endpoints,
    candidate,
    probe,
    cleanup,
  });
  if (receipt["receiptDigest"] !== digestValue(material)) return;
  const parsed = Object.freeze({
    ...material,
    receiptDigest: receipt["receiptDigest"],
  });
  authenticReceipts.add(parsed);
  return parsed;
}

export function isPhysicalIntegrationReceipt(
  value: unknown,
): value is PhysicalIntegrationReceipt {
  return (
    typeof value === "object" && value !== null && authenticReceipts.has(value)
  );
}

function sameBindings(
  value: unknown,
  expected: PhysicalIntegrationBindings,
): value is PhysicalIntegrationBindings {
  const bindings = snapshotRecord(value, [
    "requestDigest",
    "repositoryId",
    "treeDigest",
    "baselineDigest",
    "candidateDigest",
    "provenanceDigest",
  ]);
  return (
    bindings !== undefined &&
    bindings["requestDigest"] === expected.requestDigest &&
    bindings["repositoryId"] === expected.repositoryId &&
    bindings["treeDigest"] === expected.treeDigest &&
    bindings["baselineDigest"] === expected.baselineDigest &&
    bindings["candidateDigest"] === expected.candidateDigest &&
    bindings["provenanceDigest"] === expected.provenanceDigest
  );
}

function parseConnections(
  value: unknown,
): readonly PhysicalConnection[] | undefined {
  const values = snapshotArray(value, maximumEntries);
  if (values === undefined || values.length === 0) return;
  const result: PhysicalConnection[] = [];
  const names = new Set<string>();
  for (const raw of values) {
    const connection = snapshotRecord(raw, [
      "name",
      "service",
      "target",
      "scheme",
    ]);
    if (
      !(
        connection !== undefined &&
        validIdentity(connection["name"]) &&
        validIdentity(connection["service"]) &&
        validPort(connection["target"]) &&
        validScheme(connection["scheme"]) &&
        !names.has(connection["name"])
      )
    ) {
      return;
    }
    names.add(connection["name"]);
    result.push(
      Object.freeze({
        name: connection["name"],
        service: connection["service"],
        target: connection["target"],
        scheme: connection["scheme"],
      }),
    );
  }
  return Object.freeze(result);
}

function parseEndpoints(
  value: unknown,
): readonly PhysicalEndpoint[] | undefined {
  const values = snapshotArray(value, maximumEntries);
  if (values === undefined || values.length === 0) return;
  const result: PhysicalEndpoint[] = [];
  const names = new Set<string>();
  for (const raw of values) {
    const endpoint = snapshotRecord(raw, ["name", "service", "target", "url"]);
    if (
      !(
        endpoint !== undefined &&
        validIdentity(endpoint["name"]) &&
        validIdentity(endpoint["service"]) &&
        validPort(endpoint["target"]) &&
        validIdentity(endpoint["url"]) &&
        !names.has(endpoint["name"])
      )
    ) {
      return;
    }
    names.add(endpoint["name"]);
    result.push(
      Object.freeze({
        name: endpoint["name"],
        service: endpoint["service"],
        target: endpoint["target"],
        url: endpoint["url"],
      }),
    );
  }
  return Object.freeze(result);
}

function parseProbe(value: unknown): PhysicalProbeEvidence | undefined {
  const probe = snapshotRecord(value, [
    "profileId",
    "profileVersion",
    "profileDigest",
    "argv",
    "cwd",
    "environmentNames",
    "exitCode",
    "stdoutBytes",
    "stdoutDigest",
    "stderrBytes",
    "stderrDigest",
    "complete",
  ]);
  const argv = snapshotStrings(probe?.["argv"], false);
  const environmentNames = snapshotStrings(probe?.["environmentNames"], true);
  if (
    !(
      probe !== undefined &&
      validIdentity(probe["profileId"]) &&
      positiveSafeInteger(probe["profileVersion"]) &&
      validDigest(probe["profileDigest"]) &&
      argv !== undefined &&
      validIdentity(probe["cwd"]) &&
      environmentNames !== undefined &&
      probe["exitCode"] === 0 &&
      nonnegativeSafeInteger(probe["stdoutBytes"]) &&
      validDigest(probe["stdoutDigest"]) &&
      nonnegativeSafeInteger(probe["stderrBytes"]) &&
      validDigest(probe["stderrDigest"]) &&
      probe["complete"] === true
    )
  ) {
    return;
  }
  return Object.freeze({
    profileId: probe["profileId"],
    profileVersion: probe["profileVersion"],
    profileDigest: probe["profileDigest"],
    argv,
    cwd: probe["cwd"],
    environmentNames,
    exitCode: 0,
    stdoutBytes: probe["stdoutBytes"],
    stdoutDigest: probe["stdoutDigest"],
    stderrBytes: probe["stderrBytes"],
    stderrDigest: probe["stderrDigest"],
    complete: true,
  });
}

function parseCandidateEvidence(
  value: unknown,
  declarationDigest: Digest,
  manifestDigest: Digest,
  profileDigest: Digest | undefined,
  bindings: PhysicalIntegrationBindings,
  expectedTargets: readonly PhysicalCandidateTarget[],
): PhysicalCandidateEvidence | undefined {
  const candidate = snapshotRecord(value, [
    "targetSetDigest",
    "candidateDigest",
    workspaceIdentityField,
    provenanceMeasurementField,
    "targets",
  ]);
  const targetValues = snapshotArray(candidate?.["targets"], maximumEntries);
  if (
    candidate === undefined ||
    profileDigest === undefined ||
    !validDigest(candidate["targetSetDigest"]) ||
    !validDigest(candidate["candidateDigest"]) ||
    !validDigest(candidate[workspaceIdentityField]) ||
    !validDigest(candidate[provenanceMeasurementField]) ||
    targetValues === undefined ||
    targetValues.length !== expectedTargets.length
  ) {
    return;
  }
  const targets: PhysicalCandidateEvidence["targets"][number][] = [];
  for (const [index, raw] of targetValues.entries()) {
    const target = snapshotRecord(raw, ["path", "digest", "byteLength"]);
    const expected = expectedTargets[index];
    if (
      target === undefined ||
      expected === undefined ||
      target["path"] !== expected.path ||
      target["digest"] !== expected.digest ||
      target["byteLength"] !== expected.byteLength
    ) {
      return;
    }
    targets.push(
      Object.freeze({
        path: expected.path,
        digest: expected.digest,
        byteLength: expected.byteLength,
      }),
    );
  }
  const frozenTargets = Object.freeze(targets);
  const candidateDigest = digestValue(
    frozenTargets.map(({ path, digest }) => [path, digest]),
  );
  const targetSetDigest = digestValue(
    frozenTargets.map(({ path, digest, byteLength }) => [
      path,
      digest,
      byteLength,
    ]),
  );
  const provenanceMeasurementDigest = digestValue({
    declarationDigest,
    manifestDigest,
    profileDigest,
    declaredProvenanceDigest: bindings.provenanceDigest,
    workspaceIdentityDigest: candidate[workspaceIdentityField],
    targetSetDigest,
    candidateDigest,
  });
  if (
    candidateDigest !== bindings.candidateDigest ||
    candidate["candidateDigest"] !== candidateDigest ||
    candidate["targetSetDigest"] !== targetSetDigest ||
    candidate[provenanceMeasurementField] !== provenanceMeasurementDigest
  ) {
    return;
  }
  return Object.freeze({
    targetSetDigest,
    candidateDigest,
    workspaceIdentityDigest: candidate[workspaceIdentityField],
    provenanceMeasurementDigest,
    targets: frozenTargets,
  });
}

function parseCleanup(
  value: unknown,
): PhysicalIntegrationReceipt["cleanup"] | undefined {
  const cleanup = snapshotRecord(value, [
    "destroyReported",
    "labAbsent",
    "terminal",
  ]);
  if (
    !(
      cleanup !== undefined &&
      cleanup["destroyReported"] === true &&
      cleanup["labAbsent"] === true &&
      cleanup["terminal"] === true
    )
  ) {
    return;
  }
  return Object.freeze({
    destroyReported: true,
    labAbsent: true,
    terminal: true,
  });
}

function snapshotStrings(
  value: unknown,
  emptyAllowed: boolean,
): readonly string[] | undefined {
  const values = snapshotArray(value, maximumEntries);
  if (
    values === undefined ||
    (!emptyAllowed && values.length === 0) ||
    !values.every(validIdentity)
  ) {
    return;
  }
  return values;
}

function sameEndpoints(
  connections: readonly PhysicalConnection[],
  endpoints: readonly PhysicalEndpoint[],
): boolean {
  if (connections.length !== endpoints.length) return false;
  const byName = new Map(
    endpoints.map((endpoint) => [endpoint.name, endpoint]),
  );
  if (byName.size !== endpoints.length) return false;
  return connections.every((connection) => {
    const endpoint = byName.get(connection.name);
    const prefix = `${connection.scheme}://127.0.0.1:`;
    const publishedPort = endpoint?.url.startsWith(prefix)
      ? Number(endpoint.url.slice(prefix.length))
      : Number.NaN;
    return (
      endpoint !== undefined &&
      endpoint.service === connection.service &&
      endpoint.target === connection.target &&
      validPort(publishedPort) &&
      endpoint.url === `${prefix}${publishedPort}`
    );
  });
}

function declarationDigestOf(value: unknown): string | undefined {
  if (!isFrozenOpaque(value)) return;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      "declarationDigest",
    );
    return descriptor !== undefined &&
      "value" in descriptor &&
      validDigest(descriptor.value)
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\0")
  );
}

function validScheme(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9+.-]*$/u.test(value);
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}

function validPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function rejected(): PhysicalAttestationResult {
  return { status: "rejected", code: "INTEGRATION_REJECTED" };
}
