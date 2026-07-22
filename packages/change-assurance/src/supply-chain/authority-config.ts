import { isDigest } from "../digest.ts";
import type {
  RegistryMetadataAuthorityConfig,
  SupplyChainAuthorityConfig,
  SupplyWhitelistEntry,
  VulnerabilityAuthorityConfig,
} from "./contract.ts";
import {
  exactRecord,
  isLookup,
  maximumPackages,
  validIdentity,
  validLicenseId,
  validPackage,
  validUrl,
  validVersion,
} from "./values.ts";

export interface ParsedRegistryAuthorityConfig {
  readonly authorityId: string;
  readonly registryId: string;
  readonly registryUrl: string;
  readonly lookup: RegistryMetadataAuthorityConfig["lookup"];
}

export interface ParsedVulnerabilityAuthorityConfig {
  readonly authorityId: string;
  readonly databaseId: string;
  readonly databaseVersion: string;
  readonly lookup: VulnerabilityAuthorityConfig["lookup"];
}

export interface ParsedLicensePolicyConfig {
  readonly policyId: string;
  readonly allowedLicenseIds: readonly string[];
}

export interface ParsedSupplyAuthorityConfig {
  readonly authorityId: string;
  readonly whitelist: readonly SupplyWhitelistEntry[];
  readonly registry: SupplyChainAuthorityConfig["registry"];
  readonly vulnerabilities: SupplyChainAuthorityConfig["vulnerabilities"];
  readonly licenses: SupplyChainAuthorityConfig["licenses"];
}

export function parseRegistryAuthorityConfig(
  value: unknown,
): ParsedRegistryAuthorityConfig | undefined {
  const record = exactRecord(value, [
    "authorityId",
    "registryId",
    "registryUrl",
    "lookup",
  ]);
  if (!record) return;
  const authorityId = record.get("authorityId");
  const registryId = record.get("registryId");
  const registryUrl = record.get("registryUrl");
  const lookup = record.get("lookup");
  if (
    !(
      validIdentity(authorityId) &&
      validIdentity(registryId) &&
      validUrl(registryUrl) &&
      isLookup(lookup)
    )
  )
    return;
  return Object.freeze({ authorityId, registryId, registryUrl, lookup });
}

export function parseVulnerabilityAuthorityConfig(
  value: unknown,
): ParsedVulnerabilityAuthorityConfig | undefined {
  const record = exactRecord(value, [
    "authorityId",
    "databaseId",
    "databaseVersion",
    "lookup",
  ]);
  if (!record) return;
  const authorityId = record.get("authorityId");
  const databaseId = record.get("databaseId");
  const databaseVersion = record.get("databaseVersion");
  const lookup = record.get("lookup");
  if (
    !(
      validIdentity(authorityId) &&
      validIdentity(databaseId) &&
      validIdentity(databaseVersion) &&
      isLookup(lookup)
    )
  )
    return;
  return Object.freeze({ authorityId, databaseId, databaseVersion, lookup });
}

export function parseLicensePolicyConfig(
  value: unknown,
): ParsedLicensePolicyConfig | undefined {
  const record = exactRecord(value, ["policyId", "allowedLicenseIds"]);
  if (!record) return;
  const policyId = record.get("policyId");
  const allowedLicenseIds = parseLicenseIds(record.get("allowedLicenseIds"));
  if (
    !validIdentity(policyId) ||
    allowedLicenseIds === undefined ||
    allowedLicenseIds.length === 0
  )
    return;
  return Object.freeze({ policyId, allowedLicenseIds });
}

export function parseSupplyAuthorityConfig(value: unknown):
  | (Omit<
      ParsedSupplyAuthorityConfig,
      "registry" | "vulnerabilities" | "licenses"
    > & {
      readonly registry: unknown;
      readonly vulnerabilities: unknown;
      readonly licenses: unknown;
    })
  | undefined {
  const record = exactRecord(value, [
    "authorityId",
    "whitelist",
    "registry",
    "vulnerabilities",
    "licenses",
  ]);
  if (!record) return;
  const authorityId = record.get("authorityId");
  const whitelist = parseWhitelist(record.get("whitelist"));
  if (!validIdentity(authorityId) || whitelist === undefined) return;
  return Object.freeze({
    authorityId,
    whitelist,
    registry: record.get("registry"),
    vulnerabilities: record.get("vulnerabilities"),
    licenses: record.get("licenses"),
  });
}

function parseWhitelist(
  value: unknown,
): readonly SupplyWhitelistEntry[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length === 0 ||
    value.length > maximumPackages
  )
    return;
  const entries: SupplyWhitelistEntry[] = [];
  let previous = "";
  for (const raw of value) {
    const record = exactRecord(raw, [
      "name",
      "version",
      "metadataDigest",
      "packageDigest",
    ]);
    if (!record) return;
    const name = record.get("name");
    const version = record.get("version");
    const metadataDigest = record.get("metadataDigest");
    const packageDigest = record.get("packageDigest");
    const identity =
      typeof name === "string" && typeof version === "string"
        ? `${name}@${version}`
        : "";
    if (
      !(
        validPackage(name) &&
        validVersion(version) &&
        isDigest(metadataDigest) &&
        isDigest(packageDigest)
      ) ||
      identity <= previous
    )
      return;
    previous = identity;
    entries.push(
      Object.freeze({ name, version, metadataDigest, packageDigest }),
    );
  }
  return Object.freeze(entries);
}

function parseLicenseIds(value: unknown): readonly string[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length === 0 ||
    value.length > 128
  )
    return;
  const ids: string[] = [];
  let previous = "";
  for (const raw of value) {
    if (!validLicenseId(raw) || raw <= previous) return;
    previous = raw;
    ids.push(raw);
  }
  return Object.freeze(ids);
}
