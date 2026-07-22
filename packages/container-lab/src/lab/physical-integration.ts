import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type DeclaredPort, loadLabConfig } from "../config.ts";
import type { Endpoint, LabMetadata } from "../state/lab/contract.ts";
import { readLab } from "../state/lab/store.ts";
import type { PhysicalServiceSurface } from "./physical/capability.ts";
import type {
  PhysicalCandidateEvidence,
  PhysicalConnection,
  PhysicalIntegrationBindings,
  PhysicalIntegrationController,
  PhysicalIntegrationDeclaration,
  PhysicalIntegrationDeclarationResult,
  PhysicalIntegrationReceiptResult,
  PhysicalIntegrationRejectionCode,
  PhysicalProbe,
  PhysicalProbeEvidence,
  PhysicalProbeProfile,
} from "./physical/contract.ts";
import {
  candidateDigestOf,
  compareText,
  digestValue,
  parseAttestationEnvelope,
  parseBindings,
  parseCandidateTargets,
  parseDeclarationInput,
  parseProbeProfiles,
  rejected,
} from "./physical/input.ts";
import {
  destroyAndProveAbsent,
  observePhysicalProbe,
} from "./physical/probe.ts";
import {
  claimPhysicalService,
  type PhysicalServiceCapability,
} from "./service-provenance.ts";

export type {
  PhysicalCandidateEvidence,
  PhysicalCandidateMeasurement,
  PhysicalCandidateTarget,
  PhysicalCleanupProof,
  PhysicalConnection,
  PhysicalIntegrationAuthority,
  PhysicalIntegrationBindings,
  PhysicalIntegrationController,
  PhysicalIntegrationDeclaration,
  PhysicalIntegrationDeclarationResult,
  PhysicalIntegrationReceipt,
  PhysicalIntegrationReceiptResult,
  PhysicalIntegrationRejectionCode,
  PhysicalProbe,
  PhysicalProbeEvidence,
  PhysicalProbeProfile,
} from "./physical/contract.ts";

interface DeclarationRecord {
  readonly declaration: PhysicalIntegrationDeclaration;
  consumed: boolean;
}

export function createPhysicalIntegrationAuthority(
  service: PhysicalServiceSurface,
  probeProfiles: readonly PhysicalProbeProfile[],
): PhysicalIntegrationController {
  const records = new WeakMap<object, DeclarationRecord>();
  let capability: PhysicalServiceCapability | undefined;
  let profiles: ReadonlyMap<string, PhysicalProbe> | undefined;
  try {
    capability = claimPhysicalService(service);
    profiles = parseProbeProfiles(probeProfiles);
  } catch {
    capability = undefined;
    profiles = undefined;
  }
  return Object.freeze({
    declare: async (input: unknown) => {
      if (capability === undefined) return rejected("MOCKED_EVIDENCE_REJECTED");
      if (profiles === undefined) return rejected("INVALID_INPUT");
      return await declare(capability, profiles, records, input);
    },
    attest: async (input: unknown) => {
      if (capability === undefined) return rejected("MOCKED_EVIDENCE_REJECTED");
      const envelope = parseAttestationEnvelope(input);
      if (envelope === undefined) return rejected("INVALID_INPUT");
      const record = records.get(envelope.declaration);
      if (
        record === undefined ||
        record.consumed ||
        record.declaration !== envelope.declaration
      ) {
        return rejected("DECLARATION_REJECTED");
      }
      record.consumed = true;
      if (!envelope.validShape) {
        return await rejectWithCleanup(
          capability,
          record.declaration.labId,
          "INVALID_INPUT",
        );
      }
      const bindings = parseBindings(envelope.bindingsValue);
      const targets = parseCandidateTargets(envelope.candidateTargetsValue);
      if (bindings === undefined) {
        return await rejectWithCleanup(
          capability,
          record.declaration.labId,
          "INVALID_INPUT",
        );
      }
      if (targets === undefined) {
        return await rejectWithCleanup(
          capability,
          record.declaration.labId,
          "CANDIDATE_REJECTED",
        );
      }
      return await attest(capability, record.declaration, bindings, targets);
    },
  });
}

async function declare(
  capability: PhysicalServiceCapability,
  profiles: ReadonlyMap<string, PhysicalProbe>,
  records: WeakMap<object, DeclarationRecord>,
  input: unknown,
): Promise<PhysicalIntegrationDeclarationResult> {
  const parsed = parseDeclarationInput(input);
  if (parsed === undefined) return rejected("INVALID_INPUT");
  const probe = profiles.get(parsed.probeProfileId);
  if (probe === undefined) return rejected("DECLARATION_REJECTED");
  let lab: LabMetadata;
  try {
    lab = await readLab(capability.roots, capability.owner, parsed.labId);
  } catch {
    return rejected("DECLARATION_REJECTED");
  }
  if (lab.state !== "ready" || lab.runtime === undefined) {
    return rejected("LAB_NOT_READY");
  }
  const actualManifestDigest = await fileDigest(lab.manifestPath).catch(
    () => undefined,
  );
  if (actualManifestDigest !== parsed.manifestDigest) {
    return rejected("MANIFEST_MISMATCH");
  }
  const actualConnections = normalizePorts(lab.runtime.config.ports);
  if (!sameConnections(actualConnections, parsed.connections)) {
    return rejected("ENDPOINT_MISMATCH");
  }
  if (lab.sourceRepositoryIdentity === undefined) {
    return rejected("DECLARATION_REJECTED");
  }
  const material = Object.freeze({
    version: 1 as const,
    kind: "physical-integration" as const,
    owner: lab.owner,
    ownerKey: lab.ownerKey,
    labId: lab.id,
    composeProject: lab.composeProject,
    sourceRepositoryIdentity: lab.sourceRepositoryIdentity,
    labUpdatedAt: lab.updatedAt,
    manifestPath: lab.manifestPath,
    manifestDigest: actualManifestDigest,
    connections: actualConnections,
    probe,
  });
  const declaration: PhysicalIntegrationDeclaration = Object.freeze({
    ...material,
    declarationDigest: digestValue(material),
  });
  records.set(declaration, { declaration, consumed: false });
  return Object.freeze({ status: "declared", declaration });
}

async function attest(
  capability: PhysicalServiceCapability,
  declaration: PhysicalIntegrationDeclaration,
  bindings: PhysicalIntegrationBindings,
  targets: Parameters<
    PhysicalServiceCapability["synchronizeCandidates"]
  >[0]["targets"],
): Promise<PhysicalIntegrationReceiptResult> {
  let failure: PhysicalIntegrationRejectionCode | undefined;
  let endpoints: readonly Endpoint[] | undefined;
  let candidate: PhysicalCandidateEvidence | undefined;
  let probe: PhysicalProbeEvidence | undefined;
  try {
    const lab = await readLab(
      capability.roots,
      capability.owner,
      declaration.labId,
    );
    if (!sameLabIdentity(lab, declaration)) {
      failure = "DECLARATION_STALE";
    } else if (lab.state !== "ready" || lab.runtime === undefined) {
      failure = "LAB_NOT_READY";
    } else if (
      (await fileDigest(lab.manifestPath)) === declaration.manifestDigest
    ) {
      const config = await loadLabConfig(lab.sourceRoot, lab.manifestPath);
      if (
        !sameConnections(normalizePorts(config.ports), declaration.connections)
      ) {
        failure = "MANIFEST_MISMATCH";
      } else if (sameEndpoints(lab.endpoints, declaration.connections)) {
        endpoints = freezeEndpoints(lab.endpoints);
        candidate = await capability.synchronizeCandidates({
          labId: declaration.labId,
          ownerKey: declaration.ownerKey,
          composeProject: declaration.composeProject,
          sourceRepositoryIdentity: declaration.sourceRepositoryIdentity,
          labUpdatedAt: declaration.labUpdatedAt,
          declarationDigest: declaration.declarationDigest,
          manifestDigest: declaration.manifestDigest,
          profileDigest: declaration.probe.profileDigest,
          provenanceDigest: bindings.provenanceDigest,
          targets,
        });
        if (
          candidate.candidateDigest !== bindings.candidateDigest ||
          candidate.candidateDigest !== candidateDigestOf(candidate.targets)
        ) {
          failure = "CANDIDATE_DRIFTED";
        } else {
          probe = await observePhysicalProbe(capability, declaration);
          if (probe === undefined || probe.exitCode !== 0) {
            failure = "PROBE_REJECTED";
          }
        }
      } else {
        failure = "ENDPOINT_MISMATCH";
      }
    } else {
      failure = "MANIFEST_MISMATCH";
    }
  } catch {
    failure ??= "CANDIDATE_REJECTED";
  }

  const cleanup = await destroyAndProveAbsent(capability, declaration.labId);
  if (cleanup === undefined) return rejected("CLEANUP_REJECTED");
  if (failure !== undefined) return rejected(failure);
  if (
    endpoints === undefined ||
    candidate === undefined ||
    probe === undefined
  ) {
    return rejected("DECLARATION_REJECTED");
  }
  const material = Object.freeze({
    version: 1 as const,
    declarationDigest: declaration.declarationDigest,
    bindings,
    owner: declaration.owner,
    ownerKey: declaration.ownerKey,
    labId: declaration.labId,
    composeProject: declaration.composeProject,
    sourceRepositoryIdentity: declaration.sourceRepositoryIdentity,
    manifestPath: declaration.manifestPath,
    manifestDigest: declaration.manifestDigest,
    readyState: "ready" as const,
    connections: declaration.connections,
    endpoints,
    candidate,
    probe,
    cleanup,
  });
  const receipt = Object.freeze({
    ...material,
    receiptDigest: digestValue(material),
  });
  return Object.freeze({ status: "accepted", receipt });
}

async function rejectWithCleanup(
  capability: PhysicalServiceCapability,
  labId: string,
  code: PhysicalIntegrationRejectionCode,
): Promise<PhysicalIntegrationReceiptResult> {
  const cleanup = await destroyAndProveAbsent(capability, labId);
  return cleanup === undefined ? rejected("CLEANUP_REJECTED") : rejected(code);
}

function sameLabIdentity(
  lab: LabMetadata,
  declaration: PhysicalIntegrationDeclaration,
): boolean {
  return (
    lab.owner === declaration.owner &&
    lab.ownerKey === declaration.ownerKey &&
    lab.id === declaration.labId &&
    lab.composeProject === declaration.composeProject &&
    lab.sourceRepositoryIdentity === declaration.sourceRepositoryIdentity &&
    lab.updatedAt === declaration.labUpdatedAt &&
    lab.manifestPath === declaration.manifestPath
  );
}

function normalizePorts(
  ports: readonly DeclaredPort[],
): readonly PhysicalConnection[] {
  return Object.freeze(
    ports
      .map((port) =>
        Object.freeze({
          name: port.name,
          service: port.service,
          target: port.target,
          scheme: port.scheme ?? "tcp",
        }),
      )
      .sort(
        (left, right) =>
          compareText(left.name, right.name) ||
          compareText(left.service, right.service) ||
          left.target - right.target ||
          compareText(left.scheme, right.scheme),
      ),
  );
}

function sameConnections(
  left: readonly PhysicalConnection[],
  right: readonly PhysicalConnection[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameEndpoints(
  endpoints: readonly Endpoint[],
  connections: readonly PhysicalConnection[],
): boolean {
  if (endpoints.length !== connections.length) return false;
  const byName = new Map(
    endpoints.map((endpoint) => [endpoint.name, endpoint]),
  );
  if (byName.size !== endpoints.length) return false;
  return connections.every((connection) => {
    const endpoint = byName.get(connection.name);
    const prefix = `${connection.scheme}://127.0.0.1:`;
    const port = endpoint?.url.startsWith(prefix)
      ? Number(endpoint.url.slice(prefix.length))
      : Number.NaN;
    return (
      endpoint !== undefined &&
      endpoint.service === connection.service &&
      endpoint.target === connection.target &&
      Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65_535 &&
      endpoint.url === `${prefix}${port}`
    );
  });
}

function freezeEndpoints(endpoints: readonly Endpoint[]): readonly Endpoint[] {
  return Object.freeze(
    [...endpoints]
      .sort((left, right) => compareText(left.name, right.name))
      .map((endpoint) => Object.freeze({ ...endpoint })),
  );
}

async function fileDigest(path: string): Promise<string> {
  return `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
}
