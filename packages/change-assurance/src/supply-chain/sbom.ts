import { digestValue } from "../digest.ts";
import type {
  CycloneDxBom,
  CycloneDxComponent,
  CycloneDxDependency,
  LicenseEvidence,
  RegistryMetadata,
  SupplyPackageEvidence,
} from "./contract.ts";

export interface SbomPackageInput {
  readonly metadata: RegistryMetadata;
  readonly license: LicenseEvidence;
}

export interface SbomResult {
  readonly bom: CycloneDxBom;
  readonly digest: ReturnType<typeof digestValue>;
}

export function createCycloneDxBom(
  packages: readonly SbomPackageInput[],
): SbomResult {
  const sorted = [...packages].sort((left, right) =>
    packageIdentity(left.metadata).localeCompare(
      packageIdentity(right.metadata),
    ),
  );
  const components = sorted.map((entry) => component(entry));
  const dependencies = sorted.map((entry) => dependency(entry, sorted));
  const material = {
    bomFormat: "CycloneDX" as const,
    specVersion: "1.5" as const,
    version: 1 as const,
    components,
    dependencies,
  };
  const bom: CycloneDxBom = Object.freeze({
    ...material,
    serialNumber: `urn:uuid:${digestValue(material).slice("sha256:".length)}`,
    components: Object.freeze(components),
    dependencies: Object.freeze(dependencies),
  });
  return Object.freeze({ bom, digest: digestValue(bom) });
}

export function packageIdentity(
  metadata: Pick<RegistryMetadata, "name" | "version">,
): string {
  return `${metadata.name}@${metadata.version}`;
}

function component(entry: SbomPackageInput): CycloneDxComponent {
  const purl = packageUrl(entry.metadata.name, entry.metadata.version);
  return Object.freeze({
    type: "library",
    name: entry.metadata.name,
    version: entry.metadata.version,
    bomRef: purl,
    purl,
    hashes: Object.freeze([
      Object.freeze({
        alg: "SHA-256" as const,
        content: entry.metadata.packageDigest,
      }),
    ]),
    licenses: Object.freeze(
      entry.license.licenseIds.map((id) =>
        Object.freeze({ license: Object.freeze({ id }) }),
      ),
    ),
  });
}

function dependency(
  entry: SbomPackageInput,
  all: readonly SbomPackageInput[],
): CycloneDxDependency {
  const ref = packageUrl(entry.metadata.name, entry.metadata.version);
  const dependsOn = entry.metadata.dependencies
    .map((dependencyEntry) =>
      packageUrl(dependencyEntry.name, dependencyEntry.version),
    )
    .filter((candidate) =>
      all.some(
        (other) =>
          packageUrl(other.metadata.name, other.metadata.version) === candidate,
      ),
    )
    .sort((left, right) => left.localeCompare(right));
  return Object.freeze({ ref, dependsOn: Object.freeze(dependsOn) });
}

function packageUrl(name: string, version: string): string {
  const encodedName = name.startsWith("@")
    ? `@${encodeSegment(name.slice(1))}`
    : encodeSegment(name);
  return `pkg:npm/${encodedName}@${encodeSegment(version)}`;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%2F", "/");
}

export function evidenceMaterial(
  evidence: readonly SupplyPackageEvidence[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    packages: evidence.map((entry) => ({
      name: entry.name,
      version: entry.version,
      metadataDigest: entry.metadataDigest,
      packageDigest: entry.packageDigest,
      vulnerabilityDigest: entry.vulnerabilityDigest,
      licenseDigest: entry.licenseDigest,
    })),
  });
}
