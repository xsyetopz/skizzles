import { digestValue } from "../digest.ts";
import type { SupplyAuthorityState } from "./authority-state.ts";
import type {
  RegistryMetadata,
  SupplyChainPlan,
  SupplyChainReceipt,
  SupplyChainResult,
  SupplyPackageEvidence,
} from "./contract.ts";
import { parseRegistryMetadata, parseVulnerabilityReport } from "./input.ts";
import { evaluateLicense } from "./license.ts";
import { createCycloneDxBom, type SbomPackageInput } from "./sbom.ts";

export interface ParsedSupplyAssessment {
  readonly requestDigest: `sha256:${string}`;
  readonly repositoryId: string;
  readonly plan: SupplyChainPlan;
  readonly planDigest: `sha256:${string}`;
}

export async function assessParsedSupplyChain(
  state: SupplyAuthorityState,
  input: ParsedSupplyAssessment,
): Promise<SupplyChainResult> {
  const queue = [...input.plan.changes].map((change) => ({
    name: change.name,
    version: change.version,
  }));
  const visited = new Set<string>();
  const packageInputs = new Map<string, SbomPackageInput>();
  const evidence = new Map<string, SupplyPackageEvidence>();
  while (queue.length > 0) {
    const requested = queue.shift();
    if (requested === undefined) return rejected("REGISTRY_METADATA_REJECTED");
    const identity = `${requested.name}@${requested.version}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const whitelist = state.whitelist.get(identity);
    if (whitelist === undefined) return rejected("UNKNOWN_PACKAGE");
    const metadata = await readMetadata(
      state,
      requested.name,
      requested.version,
    );
    if (metadata === undefined) return rejected("REGISTRY_METADATA_REJECTED");
    if (
      metadata.metadataDigest !== whitelist.metadataDigest ||
      metadata.packageDigest !== whitelist.packageDigest
    ) {
      return rejected("REGISTRY_DRIFT");
    }
    const license = evaluateLicense(state.licenses, metadata.licenseExpression);
    if (license.status !== "accepted") return rejected(license.code);
    const vulnerability = await readVulnerability(state, metadata);
    if (vulnerability === undefined)
      return rejected("VULNERABILITY_AUTHORITY_REJECTED");
    if (vulnerability.findings.length > 0)
      return rejected("VULNERABILITY_FOUND");
    packageInputs.set(identity, { metadata, license: license.evidence });
    evidence.set(
      identity,
      Object.freeze({
        name: metadata.name,
        version: metadata.version,
        metadataDigest: metadata.metadataDigest,
        packageDigest: metadata.packageDigest,
        vulnerabilityDigest: vulnerability.reportDigest,
        licenseDigest: license.evidence.licenseDigest,
      }),
    );
    for (const dependency of metadata.dependencies) {
      const dependencyIdentity = `${dependency.name}@${dependency.version}`;
      if (!state.whitelist.has(dependencyIdentity))
        return rejected("UNKNOWN_PACKAGE");
      if (!visited.has(dependencyIdentity)) queue.push(dependency);
    }
  }
  const orderedEvidence = Object.freeze(
    [...evidence.values()].sort((left, right) =>
      packageIdentity(left).localeCompare(packageIdentity(right)),
    ),
  );
  const orderedInputs = Object.freeze(
    [...packageInputs.values()].sort((left, right) =>
      packageIdentity(left.metadata).localeCompare(
        packageIdentity(right.metadata),
      ),
    ),
  );
  const sbomResult = createCycloneDxBom(orderedInputs);
  const vulnerabilityDigest = digestValue(
    orderedEvidence.map(({ name, version, vulnerabilityDigest: digest }) => ({
      name,
      version,
      digest,
    })),
  );
  const licenseDigest = digestValue(
    orderedEvidence.map(({ name, version, licenseDigest: digest }) => ({
      name,
      version,
      digest,
    })),
  );
  const material = {
    requestDigest: input.requestDigest,
    repositoryId: input.repositoryId,
    planDigest: input.planDigest,
    registryId: state.registryState.registryId,
    packages: orderedEvidence,
    sbom: sbomResult.bom,
    sbomDigest: sbomResult.digest,
    vulnerabilityDigest,
    licenseDigest,
  };
  const receipt: SupplyChainReceipt = Object.freeze({
    ...material,
    packages: orderedEvidence,
    receiptDigest: digestValue(material),
  });
  return Object.freeze({ status: "accepted", receipt });
}

async function readMetadata(
  state: SupplyAuthorityState,
  name: string,
  version: string,
): Promise<RegistryMetadata | undefined> {
  let raw: unknown;
  try {
    raw = await state.registryState.lookup(Object.freeze({ name, version }));
  } catch {
    return;
  }
  return parseRegistryMetadata(raw, {
    authorityId: state.registryState.authorityId,
    registryId: state.registryState.registryId,
    registryUrl: state.registryState.registryUrl,
    lookup: state.registryState.lookup,
  });
}

async function readVulnerability(
  state: SupplyAuthorityState,
  metadata: RegistryMetadata,
): Promise<
  | Readonly<{
      readonly reportDigest: `sha256:${string}`;
      readonly findings: readonly unknown[];
    }>
  | undefined
> {
  let raw: unknown;
  try {
    raw = await state.vulnerabilityState.lookup(
      Object.freeze({
        name: metadata.name,
        version: metadata.version,
        metadataDigest: metadata.metadataDigest,
      }),
    );
  } catch {
    return;
  }
  const report = parseVulnerabilityReport(raw, {
    databaseId: state.vulnerabilityState.databaseId,
    databaseVersion: state.vulnerabilityState.databaseVersion,
    name: metadata.name,
    version: metadata.version,
    metadataDigest: metadata.metadataDigest,
  });
  return report === undefined
    ? undefined
    : Object.freeze({
        reportDigest: report.reportDigest,
        findings: report.findings,
      });
}

function packageIdentity(
  value: Pick<RegistryMetadata, "name" | "version">,
): string {
  return `${value.name}@${value.version}`;
}

function rejected(
  code: Extract<SupplyChainResult, { status: "rejected" }>["code"],
): SupplyChainResult {
  return Object.freeze({ status: "rejected", code });
}
