import { types } from "node:util";
import type {
  ChangeAssuranceExtensionInput,
  ChangeAssuranceExtensionResult,
} from "../contract.ts";
import { digestValue } from "../digest.ts";
import {
  createChangeAssuranceExtension,
  isChangeAssuranceExtension,
} from "../extension.ts";
import { assessParsedSupplyChain } from "./assess.ts";
import type {
  LicensePolicyState,
  RegistryAuthorityState,
  SupplyAuthorityState,
  VulnerabilityAuthorityState,
} from "./authority-state.ts";
import {
  licenseState,
  registryState,
  supplyState,
  vulnerabilityState,
} from "./authority-state.ts";
import type {
  LicensePolicyAuthority,
  LicensePolicyAuthorityCreationResult,
  RegistryMetadataAuthority,
  RegistryMetadataAuthorityCreationResult,
  SupplyChainAssessmentInput,
  SupplyChainAuthority,
  SupplyChainAuthorityCreationResult,
  SupplyChainReceipt,
  SupplyChainResult,
  VulnerabilityAuthority,
  VulnerabilityAuthorityCreationResult,
} from "./contract.ts";
import {
  digestSupplyPlan,
  parseLicensePolicyConfig,
  parseRegistryAuthorityConfig,
  parseSupplyAuthorityConfig,
  parseSupplyPlan,
  parseVulnerabilityAuthorityConfig,
} from "./input.ts";
import { bindLicensePolicyState } from "./license.ts";

const registries = new WeakMap<object, RegistryAuthorityState>();
const vulnerabilityAuthorities = new WeakMap<
  object,
  VulnerabilityAuthorityState
>();
const licenseAuthorities = new WeakMap<object, LicensePolicyState>();
const supplyAuthorities = new WeakMap<object, SupplyAuthorityState>();
const receipts = new WeakSet<object>();

export function createRegistryMetadataAuthority(
  input: unknown,
): RegistryMetadataAuthorityCreationResult {
  const parsed = parseRegistryAuthorityConfig(input);
  if (parsed === undefined)
    return Object.freeze({
      status: "rejected",
      code: "INVALID_REGISTRY_AUTHORITY_CONFIG",
    });
  const authority: RegistryMetadataAuthority = Object.freeze({
    kind: "registry-metadata-authority",
    authorityId: parsed.authorityId,
    registryId: parsed.registryId,
  });
  registries.set(authority, registryState(parsed));
  return Object.freeze({ status: "created", authority });
}

export function isRegistryMetadataAuthority(
  input: unknown,
): input is RegistryMetadataAuthority {
  return typeof input === "object" && input !== null && registries.has(input);
}

export function createVulnerabilityAuthority(
  input: unknown,
): VulnerabilityAuthorityCreationResult {
  const parsed = parseVulnerabilityAuthorityConfig(input);
  if (parsed === undefined)
    return Object.freeze({
      status: "rejected",
      code: "INVALID_VULNERABILITY_AUTHORITY_CONFIG",
    });
  const authority: VulnerabilityAuthority = Object.freeze({
    kind: "vulnerability-authority",
    authorityId: parsed.authorityId,
    databaseId: parsed.databaseId,
  });
  vulnerabilityAuthorities.set(authority, vulnerabilityState(parsed));
  return Object.freeze({ status: "created", authority });
}

export function isVulnerabilityAuthority(
  input: unknown,
): input is VulnerabilityAuthority {
  return (
    typeof input === "object" &&
    input !== null &&
    vulnerabilityAuthorities.has(input)
  );
}

export function createLicensePolicyAuthority(
  input: unknown,
): LicensePolicyAuthorityCreationResult {
  const parsed = parseLicensePolicyConfig(input);
  if (parsed === undefined)
    return Object.freeze({
      status: "rejected",
      code: "INVALID_LICENSE_POLICY_CONFIG",
    });
  const authority: LicensePolicyAuthority = Object.freeze({
    kind: "license-policy-authority",
    policyId: parsed.policyId,
  });
  const state = licenseState(parsed);
  licenseAuthorities.set(authority, state);
  bindLicensePolicyState(authority, state);
  return Object.freeze({ status: "created", authority });
}

export function isLicensePolicyAuthority(
  input: unknown,
): input is LicensePolicyAuthority {
  return (
    typeof input === "object" && input !== null && licenseAuthorities.has(input)
  );
}

export function createSupplyChainAuthority(
  input: unknown,
): SupplyChainAuthorityCreationResult {
  const parsed = parseSupplyAuthorityConfig(input);
  if (
    parsed === undefined ||
    !isRegistryMetadataAuthority(parsed.registry) ||
    !isVulnerabilityAuthority(parsed.vulnerabilities) ||
    !isLicensePolicyAuthority(parsed.licenses)
  ) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_SUPPLY_AUTHORITY_CONFIG",
    });
  }
  const authority: SupplyChainAuthority = Object.freeze({
    kind: "supply-chain-authority",
    authorityId: parsed.authorityId,
  });
  const registryStateValue = registries.get(parsed.registry);
  const vulnerabilityStateValue = vulnerabilityAuthorities.get(
    parsed.vulnerabilities,
  );
  if (
    registryStateValue === undefined ||
    vulnerabilityStateValue === undefined
  ) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_SUPPLY_AUTHORITY_CONFIG",
    });
  }
  supplyAuthorities.set(
    authority,
    supplyState({
      authorityId: parsed.authorityId,
      whitelist: parsed.whitelist,
      registry: parsed.registry,
      registryState: registryStateValue,
      vulnerabilities: parsed.vulnerabilities,
      vulnerabilityState: vulnerabilityStateValue,
      licenses: parsed.licenses,
    }),
  );
  return Object.freeze({ status: "created", authority });
}

export function isSupplyChainAuthority(
  input: unknown,
): input is SupplyChainAuthority {
  return (
    typeof input === "object" && input !== null && supplyAuthorities.has(input)
  );
}

export function createSupplyChainAssuranceExtension(
  input: unknown,
): import("../contract.ts").ChangeAssuranceExtensionCreationResult {
  if (!exactExtensionInput(input) || !isSupplyChainAuthority(input.authority)) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_EXTENSION_CONFIG",
    });
  }
  return createChangeAssuranceExtension({
    domain: "supply-chain",
    id: input.id,
    version: input.version,
    assess: (extensionInput: ChangeAssuranceExtensionInput) =>
      assessSupplyChainExtension(input.authority, extensionInput),
  });
}

export function isSupplyChainAssuranceExtension(
  input: unknown,
): input is import("../contract.ts").ChangeAssuranceExtension {
  return isChangeAssuranceExtension(input) && input.domain === "supply-chain";
}

export async function assessSupplyChain(
  authority: unknown,
  input: unknown,
): Promise<SupplyChainResult> {
  if (!isSupplyChainAuthority(authority))
    return Object.freeze({
      status: "rejected",
      code: "UNAUTHENTIC_SUPPLY_AUTHORITY",
    });
  const state = supplyAuthorities.get(authority);
  if (state === undefined)
    return Object.freeze({
      status: "rejected",
      code: "UNAUTHENTIC_SUPPLY_AUTHORITY",
    });
  if (!isAssessmentInput(input))
    return Object.freeze({ status: "rejected", code: "INVALID_SUPPLY_INPUT" });
  const plan = parseSupplyPlan(input.plan);
  if (plan === undefined)
    return Object.freeze({ status: "rejected", code: "SUPPLY_PLAN_REJECTED" });
  try {
    const result = await assessParsedSupplyChain(state, {
      requestDigest: input.requestDigest,
      repositoryId: input.repositoryId,
      plan,
      planDigest: digestSupplyPlan(plan),
    });
    if (result.status === "accepted") receipts.add(result.receipt);
    return result;
  } catch {
    return Object.freeze({
      status: "rejected",
      code: "REGISTRY_METADATA_REJECTED",
    });
  }
}

export async function assessSupplyChainExtension(
  authority: unknown,
  input: ChangeAssuranceExtensionInput,
): Promise<ChangeAssuranceExtensionResult> {
  if (input.domain !== "supply-chain")
    return Object.freeze({
      status: "rejected",
      code: "SUPPLY_CHAIN_DOMAIN_MISMATCH",
    });
  const result = await assessSupplyChain(
    authority,
    Object.freeze({
      requestDigest: input.requestDigest,
      repositoryId: input.repositoryId,
      plan: input.plan,
    }),
  );
  if (result.status !== "accepted")
    return Object.freeze({ status: "rejected", code: result.code });
  return Object.freeze({
    status: "accepted",
    evidenceDigest: digestValue({
      requestDigest: input.requestDigest,
      repositoryId: input.repositoryId,
      treeDigest: input.treeDigest,
      baselineDigest: input.baselineDigest,
      declarationDigest: input.declarationDigest,
      planDigest: result.receipt.planDigest,
      metadataDigest: digestValue(
        result.receipt.packages.map(({ metadataDigest }) => metadataDigest),
      ),
      sbomDigest: result.receipt.sbomDigest,
      vulnerabilityDigest: result.receipt.vulnerabilityDigest,
      licenseDigest: result.receipt.licenseDigest,
      receiptDigest: result.receipt.receiptDigest,
    }),
  });
}

export function isSupplyChainReceipt(
  input: unknown,
): input is SupplyChainReceipt {
  return typeof input === "object" && input !== null && receipts.has(input);
}

function isAssessmentInput(
  input: unknown,
): input is SupplyChainAssessmentInput {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    !Object.isFrozen(input)
  )
    return false;
  const own = Reflect.ownKeys(input);
  if (
    own.length !== 3 ||
    !["requestDigest", "repositoryId", "plan"].every((key) => own.includes(key))
  )
    return false;
  const requestDescriptor = Object.getOwnPropertyDescriptor(
    input,
    "requestDigest",
  );
  const repositoryDescriptor = Object.getOwnPropertyDescriptor(
    input,
    "repositoryId",
  );
  if (
    requestDescriptor === undefined ||
    !("value" in requestDescriptor) ||
    repositoryDescriptor === undefined ||
    !("value" in repositoryDescriptor)
  )
    return false;
  const requestDigest = requestDescriptor.value;
  const repositoryId = repositoryDescriptor.value;
  return (
    typeof requestDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(requestDigest) &&
    typeof repositoryId === "string" &&
    repositoryId.length > 0 &&
    repositoryId.length <= 256
  );
}

function exactExtensionInput(value: unknown): value is Readonly<{
  readonly id: string;
  readonly version: string;
  readonly authority: unknown;
}> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  )
    return false;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== 3 ||
    !["id", "version", "authority"].every((key) => own.includes(key))
  )
    return false;
  const id = Reflect.get(value, "id");
  const version = Reflect.get(value, "version");
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    typeof version === "string" &&
    version.length > 0 &&
    version.length <= 64
  );
}
