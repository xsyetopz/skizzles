import type {
  AssuranceJsonValue,
  ChangeAssuranceExtension,
  ChangeAssuranceExtensionCreationResult,
  ChangeAssuranceExtensionInput,
  ChangeAssuranceExtensionResult,
} from "../contract.ts";
import type { Digest } from "../digest.ts";

export type PackageChangeOperation = "add" | "update";

export interface PackageChange {
  readonly [key: string]: AssuranceJsonValue;
  readonly name: string;
  readonly version: string;
  readonly operation: PackageChangeOperation;
}

export interface SupplyChainPlan {
  readonly [key: string]: AssuranceJsonValue;
  readonly schemaVersion: 1;
  readonly changes: readonly PackageChange[];
}

export type SupplyChainPlanCreationResult =
  | Readonly<{ readonly status: "created"; readonly plan: SupplyChainPlan }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: "INVALID_SUPPLY_PLAN";
    }>;

export interface RegistryMetadataRequest {
  readonly name: string;
  readonly version: string;
}

export interface RegistryDependency {
  readonly name: string;
  readonly version: string;
}

export interface RegistryMetadata {
  readonly registryId: string;
  readonly registryUrl: string;
  readonly name: string;
  readonly version: string;
  readonly packageDigest: Digest;
  readonly licenseExpression: string;
  readonly dependencies: readonly RegistryDependency[];
  readonly metadataDigest: Digest;
}

export type RegistryMetadataLookup = (
  request: RegistryMetadataRequest,
) => unknown | Promise<unknown>;

export interface RegistryMetadataAuthorityConfig {
  readonly authorityId: string;
  readonly registryId: string;
  readonly registryUrl: string;
  readonly lookup: RegistryMetadataLookup;
}

export interface RegistryMetadataAuthority {
  readonly kind: "registry-metadata-authority";
  readonly authorityId: string;
  readonly registryId: string;
}

export type RegistryMetadataAuthorityCreationResult =
  | Readonly<{
      readonly status: "created";
      readonly authority: RegistryMetadataAuthority;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: "INVALID_REGISTRY_AUTHORITY_CONFIG";
    }>;

export interface VulnerabilityQuery {
  readonly name: string;
  readonly version: string;
  readonly metadataDigest: Digest;
}

export type VulnerabilitySeverity = "low" | "moderate" | "high" | "critical";

export interface VulnerabilityFinding {
  readonly id: string;
  readonly severity: VulnerabilitySeverity;
}

export interface VulnerabilityReport {
  readonly databaseId: string;
  readonly databaseVersion: string;
  readonly name: string;
  readonly version: string;
  readonly metadataDigest: Digest;
  readonly findings: readonly VulnerabilityFinding[];
  readonly reportDigest: Digest;
}

export type VulnerabilityLookup = (
  query: VulnerabilityQuery,
) => unknown | Promise<unknown>;

export interface VulnerabilityAuthorityConfig {
  readonly authorityId: string;
  readonly databaseId: string;
  readonly databaseVersion: string;
  readonly lookup: VulnerabilityLookup;
}

export interface VulnerabilityAuthority {
  readonly kind: "vulnerability-authority";
  readonly authorityId: string;
  readonly databaseId: string;
}

export type VulnerabilityAuthorityCreationResult =
  | Readonly<{
      readonly status: "created";
      readonly authority: VulnerabilityAuthority;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: "INVALID_VULNERABILITY_AUTHORITY_CONFIG";
    }>;

export interface LicensePolicyConfig {
  readonly policyId: string;
  readonly allowedLicenseIds: readonly string[];
}

export interface LicensePolicyAuthority {
  readonly kind: "license-policy-authority";
  readonly policyId: string;
}

export type LicensePolicyAuthorityCreationResult =
  | Readonly<{
      readonly status: "created";
      readonly authority: LicensePolicyAuthority;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: "INVALID_LICENSE_POLICY_CONFIG";
    }>;

export interface LicenseEvidence {
  readonly rawExpression: string;
  readonly normalizedExpression: string;
  readonly licenseIds: readonly string[];
  readonly licenseDigest: Digest;
}

export interface SupplyWhitelistEntry {
  readonly name: string;
  readonly version: string;
  readonly metadataDigest: Digest;
  readonly packageDigest: Digest;
}

export interface SupplyChainAuthorityConfig {
  readonly authorityId: string;
  readonly whitelist: readonly SupplyWhitelistEntry[];
  readonly registry: RegistryMetadataAuthority;
  readonly vulnerabilities: VulnerabilityAuthority;
  readonly licenses: LicensePolicyAuthority;
}

export interface SupplyChainAuthority {
  readonly kind: "supply-chain-authority";
  readonly authorityId: string;
}

export interface SupplyChainAssuranceExtensionConfig {
  readonly id: string;
  readonly version: string;
  readonly authority: SupplyChainAuthority;
}

export type SupplyChainAssuranceExtensionCreationResult =
  ChangeAssuranceExtensionCreationResult;
export type SupplyChainAssuranceExtension = ChangeAssuranceExtension;

export type SupplyChainAuthorityCreationResult =
  | Readonly<{
      readonly status: "created";
      readonly authority: SupplyChainAuthority;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: "INVALID_SUPPLY_AUTHORITY_CONFIG";
    }>;

export interface SupplyPackageEvidence {
  readonly name: string;
  readonly version: string;
  readonly metadataDigest: Digest;
  readonly packageDigest: Digest;
  readonly vulnerabilityDigest: Digest;
  readonly licenseDigest: Digest;
}

export interface CycloneDxComponent {
  readonly type: "library";
  readonly name: string;
  readonly version: string;
  readonly bomRef: string;
  readonly purl: string;
  readonly hashes: readonly Readonly<{
    readonly alg: "SHA-256";
    readonly content: Digest;
  }>[];
  readonly licenses: readonly Readonly<{
    readonly license: Readonly<{ readonly id: string }>;
  }>[];
}

export interface CycloneDxDependency {
  readonly ref: string;
  readonly dependsOn: readonly string[];
}

export interface CycloneDxBom {
  readonly bomFormat: "CycloneDX";
  readonly specVersion: "1.5";
  readonly serialNumber: string;
  readonly version: 1;
  readonly components: readonly CycloneDxComponent[];
  readonly dependencies: readonly CycloneDxDependency[];
}

export interface SupplyChainReceipt {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly planDigest: Digest;
  readonly registryId: string;
  readonly packages: readonly SupplyPackageEvidence[];
  readonly sbom: CycloneDxBom;
  readonly sbomDigest: Digest;
  readonly vulnerabilityDigest: Digest;
  readonly licenseDigest: Digest;
  readonly receiptDigest: Digest;
}

export interface SupplyChainAssessmentInput {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly plan: unknown;
}

export type SupplyChainFailureCode =
  | "INVALID_SUPPLY_INPUT"
  | "UNAUTHENTIC_SUPPLY_AUTHORITY"
  | "SUPPLY_PLAN_REJECTED"
  | "UNKNOWN_PACKAGE"
  | "REGISTRY_METADATA_REJECTED"
  | "REGISTRY_DRIFT"
  | "VULNERABILITY_AUTHORITY_REJECTED"
  | "VULNERABILITY_FOUND"
  | "LICENSE_POLICY_REJECTED"
  | "SBOM_REJECTED";

export type SupplyChainResult =
  | Readonly<{
      readonly status: "accepted";
      readonly receipt: SupplyChainReceipt;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: SupplyChainFailureCode;
    }>;

export type SupplyChainExtensionAssessor = (
  authority: unknown,
  input: ChangeAssuranceExtensionInput,
) => Promise<ChangeAssuranceExtensionResult>;
