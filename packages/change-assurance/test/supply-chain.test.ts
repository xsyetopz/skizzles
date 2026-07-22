import { describe, expect, it } from "bun:test";
import type { ChangeAssuranceExtensionInput } from "../src/contract.ts";
import { createChangeDeclaration } from "../src/declaration.ts";
import { digestBytes, digestValue } from "../src/digest.ts";
import { createChangeAssuranceExtension } from "../src/extension.ts";
import { createChangeAssurance } from "../src/runtime.ts";
import {
  assessSupplyChain,
  createLicensePolicyAuthority,
  createRegistryMetadataAuthority,
  createSupplyChainAssuranceExtension,
  createSupplyChainAuthority,
  createVulnerabilityAuthority,
  isSupplyChainAuthority,
} from "../src/supply-chain/authority.ts";
import type {
  RegistryMetadata,
  SupplyChainAuthority,
  VulnerabilityFinding,
  VulnerabilityReport,
} from "../src/supply-chain/contract.ts";
import {
  createSupplyChainPlan,
  digestMetadata,
} from "../src/supply-chain/input.ts";

const encoder = new TextEncoder();
const registryId = "npm-public";
const registryUrl = "https://registry.example.test";
const databaseId = "osv";
const databaseVersion = "2026-07-22";

describe("supply-chain assurance", () => {
  it("accepts a curated package and emits deterministic CycloneDX evidence", async () => {
    const metadata = packageMetadata("MIT");
    const authorities = makeAuthorities(metadata);
    const result = await assessSupplyChain(
      authorities.supply,
      assessment(plan("safe", metadata.version)),
    );
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") {
      throw new Error("safe package was rejected");
    }
    expect(result.receipt.sbom.bomFormat).toBe("CycloneDX");
    expect(result.receipt.sbom.components[0]?.purl).toBe("pkg:npm/safe@1.0.0");
    expect(result.receipt.packages[0]?.metadataDigest).toBe(
      metadata.metadataDigest,
    );
    expect(Object.isFrozen(result.receipt)).toBe(true);
  });

  it("rejects forged authorities and package identities outside the whitelist", async () => {
    const metadata = packageMetadata("MIT");
    const authorities = makeAuthorities(metadata);
    const fake = Object.freeze({
      kind: "supply-chain-authority",
      authorityId: "fake",
    });
    expect(isSupplyChainAuthority(fake)).toBe(false);
    await expect(
      assessSupplyChain(fake, assessment(plan("safe", metadata.version))),
    ).resolves.toEqual({
      status: "rejected",
      code: "UNAUTHENTIC_SUPPLY_AUTHORITY",
    });
    await expect(
      assessSupplyChain(
        authorities.supply,
        assessment(plan("unknown", "1.0.0")),
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "UNKNOWN_PACKAGE",
    });
  });

  it("rejects registry drift even when the replacement metadata is internally consistent", async () => {
    const metadata = packageMetadata("MIT");
    let current = metadata;
    const authorities = makeAuthorities(metadata, () => current);
    const replacement = packageMetadata("MIT", "different-bytes");
    current = replacement;
    await expect(
      assessSupplyChain(
        authorities.supply,
        assessment(plan("safe", metadata.version)),
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "REGISTRY_DRIFT",
    });
  });

  it("rejects active vulnerability findings before publication", async () => {
    const metadata = packageMetadata("MIT");
    let current: VulnerabilityReport = emptyReport(metadata);
    const authorities = makeAuthorities(metadata, undefined, () => current);
    const finding: VulnerabilityFinding = Object.freeze({
      id: "OSV-2026-0001",
      severity: "high",
    });
    current = report(metadata, Object.freeze([finding]));
    await expect(
      assessSupplyChain(
        authorities.supply,
        assessment(plan("safe", metadata.version)),
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "VULNERABILITY_FOUND",
    });
  });

  it("rejects licenses outside the explicit SPDX allowlist", async () => {
    const metadata = packageMetadata("GPL-3.0-only");
    const authorities = makeAuthorities(metadata);
    await expect(
      assessSupplyChain(
        authorities.supply,
        assessment(plan("safe", metadata.version)),
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "LICENSE_POLICY_REJECTED",
    });
  });

  it("rejects caller measurements and raw package-manager-shaped plans", async () => {
    const metadata = packageMetadata("MIT");
    const authorities = makeAuthorities(metadata);
    const invalidPlan = Object.freeze({
      schemaVersion: 1,
      command: "bun add safe",
      changes: Object.freeze([
        Object.freeze({
          name: "safe",
          version: metadata.version,
          operation: "add",
        }),
      ]),
    });
    await expect(
      assessSupplyChain(authorities.supply, assessment(invalidPlan)),
    ).resolves.toEqual({
      status: "rejected",
      code: "SUPPLY_PLAN_REJECTED",
    });
  });

  it("passes the supply authority through the generic core extension runtime", async () => {
    const metadata = packageMetadata("MIT");
    const authorities = makeAuthorities(metadata);
    const supplyExtension = createSupplyChainAssuranceExtension(
      Object.freeze({
        id: "supply-chain",
        version: "1",
        authority: authorities.supply,
      }),
    );
    if (supplyExtension.status !== "created") {
      throw new Error("supply extension failed");
    }
    const otherExtensions = [
      extension("middleware-security"),
      extension("migration-configuration-secrets"),
      extension("performance"),
    ];
    const requestDigest = digestValue("request");
    const declaration = createChangeDeclaration(
      Object.freeze({
        requestDigest,
        repositoryId: "repo-a",
        targets: Object.freeze([
          Object.freeze({ path: "src/value.ts", operation: "write" }),
        ]),
        plans: Object.freeze({
          "middleware-security": Object.freeze({}),
          "migration-configuration-secrets": Object.freeze({}),
          performance: Object.freeze({}),
          "supply-chain": plan("safe", metadata.version),
        }),
      }),
    );
    if (declaration.status !== "created") throw new Error("declaration failed");
    const assurance = createChangeAssurance(
      Object.freeze({
        extensions: Object.freeze([
          otherExtensions[0],
          otherExtensions[1],
          otherExtensions[2],
          supplyExtension.extension,
        ]),
      }),
    );
    if (assurance.status !== "created") throw new Error("assurance failed");
    const candidateBytes = Object.freeze([...encoder.encode("candidate")]);
    const result = await assurance.changeAssurance.assess(
      Object.freeze({
        requestDigest,
        repositoryId: "repo-a",
        treeDigest: digestValue("tree"),
        baselineDigest: digestValue("baseline"),
        declaration: declaration.declaration,
        targets: Object.freeze([
          Object.freeze({
            path: "src/value.ts",
            operation: "write",
            baselineBytes: Object.freeze([...encoder.encode("baseline")]),
            candidateBytes,
          }),
        ]),
      }),
    );
    expect(result.status).toBe("accepted");
  });
});

function extension(
  domain:
    | "middleware-security"
    | "migration-configuration-secrets"
    | "performance",
) {
  const result = createChangeAssuranceExtension({
    domain,
    id: `${domain}-fixture`,
    version: "1",
    assess: (_input: ChangeAssuranceExtensionInput) => ({
      status: "accepted",
      evidenceDigest: digestValue(domain),
    }),
  });
  if (result.status !== "created") throw new Error("fixture extension failed");
  return result.extension;
}

function makeAuthorities(
  metadata: RegistryMetadata,
  registryLookup?: () => RegistryMetadata,
  vulnerabilityLookup?: () => VulnerabilityReport,
): Readonly<{
  readonly supply: SupplyChainAuthority;
}> {
  const registry = createRegistryMetadataAuthority(
    Object.freeze({
      authorityId: "registry-authority",
      registryId,
      registryUrl,
      lookup: () => registryLookup?.() ?? metadata,
    }),
  );
  if (registry.status !== "created") {
    throw new Error("registry authority failed");
  }
  const vulnerabilities = createVulnerabilityAuthority(
    Object.freeze({
      authorityId: "vulnerability-authority",
      databaseId,
      databaseVersion,
      lookup: () => vulnerabilityLookup?.() ?? emptyReport(metadata),
    }),
  );
  if (vulnerabilities.status !== "created") {
    throw new Error("vulnerability authority failed");
  }
  const licenses = createLicensePolicyAuthority(
    Object.freeze({
      policyId: "license-policy",
      allowedLicenseIds: Object.freeze(["MIT"]),
    }),
  );
  if (licenses.status !== "created") throw new Error("license policy failed");
  const supply = createSupplyChainAuthority(
    Object.freeze({
      authorityId: "supply-authority",
      whitelist: Object.freeze([
        Object.freeze({
          name: metadata.name,
          version: metadata.version,
          metadataDigest: metadata.metadataDigest,
          packageDigest: metadata.packageDigest,
        }),
      ]),
      registry: registry.authority,
      vulnerabilities: vulnerabilities.authority,
      licenses: licenses.authority,
    }),
  );
  if (supply.status !== "created") throw new Error("supply authority failed");
  return { supply: supply.authority };
}

function packageMetadata(
  licenseExpression: string,
  source = "safe-package",
): RegistryMetadata {
  const packageDigest = digestBytes(Uint8Array.from(encoder.encode(source)));
  const base = {
    registryId,
    registryUrl,
    name: "safe",
    version: "1.0.0",
    packageDigest,
    licenseExpression,
    dependencies: Object.freeze([]),
  };
  return Object.freeze({ ...base, metadataDigest: digestMetadata(base) });
}

function emptyReport(metadata: RegistryMetadata): VulnerabilityReport {
  return report(metadata, Object.freeze([]));
}

function report(
  metadata: RegistryMetadata,
  findings: readonly VulnerabilityFinding[],
): VulnerabilityReport {
  const base = {
    databaseId,
    databaseVersion,
    name: metadata.name,
    version: metadata.version,
    metadataDigest: metadata.metadataDigest,
    findings,
  };
  return Object.freeze({ ...base, reportDigest: digestValue(base) });
}

function plan(name: string, version: string): unknown {
  const result = createSupplyChainPlan(
    Object.freeze({
      schemaVersion: 1,
      changes: Object.freeze([
        Object.freeze({ name, version, operation: "add" }),
      ]),
    }),
  );
  if (result.status !== "created") throw new Error("plan creation failed");
  return result.plan;
}

function assessment(value: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({
    requestDigest: digestValue("request"),
    repositoryId: "repo-a",
    plan: value,
  });
}
