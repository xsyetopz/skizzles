import type {
  LicensePolicyAuthority,
  RegistryMetadataAuthority,
  SupplyWhitelistEntry,
  VulnerabilityAuthority,
} from "./contract.ts";
import type {
  ParsedLicensePolicyConfig,
  ParsedRegistryAuthorityConfig,
  ParsedSupplyAuthorityConfig,
  ParsedVulnerabilityAuthorityConfig,
} from "./input.ts";

export interface RegistryAuthorityState {
  readonly authorityId: string;
  readonly registryId: string;
  readonly registryUrl: string;
  readonly lookup: ParsedRegistryAuthorityConfig["lookup"];
}

export interface VulnerabilityAuthorityState {
  readonly authorityId: string;
  readonly databaseId: string;
  readonly databaseVersion: string;
  readonly lookup: ParsedVulnerabilityAuthorityConfig["lookup"];
}

export interface LicensePolicyState {
  readonly policyId: string;
  readonly allowedLicenseIds: readonly string[];
}

export interface SupplyAuthorityState {
  readonly authorityId: string;
  readonly whitelist: ReadonlyMap<string, SupplyWhitelistEntry>;
  readonly registry: RegistryMetadataAuthority;
  readonly registryState: RegistryAuthorityState;
  readonly vulnerabilities: VulnerabilityAuthority;
  readonly vulnerabilityState: VulnerabilityAuthorityState;
  readonly licenses: LicensePolicyAuthority;
}

export function registryState(
  config: ParsedRegistryAuthorityConfig,
): RegistryAuthorityState {
  return Object.freeze({ ...config });
}

export function vulnerabilityState(
  config: ParsedVulnerabilityAuthorityConfig,
): VulnerabilityAuthorityState {
  return Object.freeze({ ...config });
}

export function licenseState(
  config: ParsedLicensePolicyConfig,
): LicensePolicyState {
  return Object.freeze({
    ...config,
    allowedLicenseIds: Object.freeze([...config.allowedLicenseIds]),
  });
}

export function supplyState(
  config: ParsedSupplyAuthorityConfig & {
    readonly registry: RegistryMetadataAuthority;
    readonly registryState: RegistryAuthorityState;
    readonly vulnerabilities: VulnerabilityAuthority;
    readonly vulnerabilityState: VulnerabilityAuthorityState;
    readonly licenses: LicensePolicyAuthority;
  },
): SupplyAuthorityState {
  return Object.freeze({
    authorityId: config.authorityId,
    whitelist: new Map(
      config.whitelist.map((entry) => [
        `${entry.name}@${entry.version}`,
        entry,
      ]),
    ),
    registry: config.registry,
    registryState: config.registryState,
    vulnerabilities: config.vulnerabilities,
    vulnerabilityState: config.vulnerabilityState,
    licenses: config.licenses,
  });
}
