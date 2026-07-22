import type { Digest } from "../../digest.ts";
import { digestValue, isDigest } from "../../digest.ts";
import type { ParsedRegistryAuthorityConfig } from "../authority-config.ts";
import type { RegistryDependency, RegistryMetadata } from "../contract.ts";
import {
  exactRecord,
  maximumDependencies,
  maximumLicenseLength,
  validPackage,
  validVersion,
} from "../values.ts";

export function parseRegistryMetadata(
  value: unknown,
  authority: ParsedRegistryAuthorityConfig,
): RegistryMetadata | undefined {
  const record = exactRecord(value, [
    "registryId",
    "registryUrl",
    "name",
    "version",
    "packageDigest",
    "licenseExpression",
    "dependencies",
    "metadataDigest",
  ]);
  if (!record) return;
  const registryId = record.get("registryId");
  const registryUrl = record.get("registryUrl");
  const name = record.get("name");
  const version = record.get("version");
  const packageDigest = record.get("packageDigest");
  const licenseExpression = record.get("licenseExpression");
  const dependencies = parseDependencies(record.get("dependencies"));
  const metadataDigest = record.get("metadataDigest");
  if (
    registryId !== authority.registryId ||
    registryUrl !== authority.registryUrl ||
    !validPackage(name) ||
    !validVersion(version) ||
    !isDigest(packageDigest) ||
    typeof licenseExpression !== "string" ||
    licenseExpression.length === 0 ||
    licenseExpression.length > maximumLicenseLength ||
    dependencies === undefined ||
    !isDigest(metadataDigest)
  )
    return;
  const expectedDigest = digestMetadata({
    registryId,
    registryUrl,
    name,
    version,
    packageDigest,
    licenseExpression,
    dependencies,
  });
  if (metadataDigest !== expectedDigest) return;
  return Object.freeze({
    registryId,
    registryUrl,
    name,
    version,
    packageDigest,
    licenseExpression,
    dependencies,
    metadataDigest,
  });
}

export function digestMetadata(
  value: Omit<RegistryMetadata, "metadataDigest">,
): Digest {
  return digestValue({
    registryId: value.registryId,
    registryUrl: value.registryUrl,
    name: value.name,
    version: value.version,
    packageDigest: value.packageDigest,
    licenseExpression: value.licenseExpression,
    dependencies: value.dependencies,
  });
}

function parseDependencies(
  value: unknown,
): readonly RegistryDependency[] | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length > maximumDependencies
  )
    return;
  const dependencies: RegistryDependency[] = [];
  let previous = "";
  for (const raw of value) {
    const record = exactRecord(raw, ["name", "version"]);
    if (!record) return;
    const name = record.get("name");
    const version = record.get("version");
    const identity =
      typeof name === "string" && typeof version === "string"
        ? `${name}@${version}`
        : "";
    if (!(validPackage(name) && validVersion(version)) || identity <= previous)
      return;
    previous = identity;
    dependencies.push(Object.freeze({ name, version }));
  }
  return Object.freeze(dependencies);
}
