import type {
  RegistryMetadataAuthorityConfig,
  VulnerabilityAuthorityConfig,
} from "./contract.ts";

export const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
export const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
export const maximumIdentityLength = 128;
export const maximumRegistryUrlLength = 2048;
export const maximumPackages = 512;
export const maximumDependencies = 512;
export const maximumLicenseLength = 256;
export const maximumVulnerabilityFindings = 1024;

export function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumIdentityLength &&
    !/[\0\r\n]/u.test(value)
  );
}

export function validPackage(value: unknown): value is string {
  return typeof value === "string" && packageNamePattern.test(value);
}

export function validVersion(value: unknown): value is string {
  return typeof value === "string" && versionPattern.test(value);
}

export function validUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumRegistryUrlLength
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function validLicenseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(value) &&
    value.length <= 128
  );
}

export function isLookup(
  value: unknown,
): value is RegistryMetadataAuthorityConfig["lookup"] {
  return typeof value === "function";
}

export function isVulnerabilityLookup(
  value: unknown,
): value is VulnerabilityAuthorityConfig["lookup"] {
  return typeof value === "function";
}

export function exactRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  )
    return;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    return;
  const result = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    result.set(key, descriptor.value);
  }
  return result;
}
