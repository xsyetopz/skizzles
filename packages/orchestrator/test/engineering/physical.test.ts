import { describe, expect, it } from "bun:test";
import { digestValue } from "../../src/digest.ts";
import {
  attestPhysicalIntegration,
  type PhysicalIntegrationBindings,
} from "../../src/engineering/physical.ts";

const hexLength = 64;
const digest = `sha256:${"a".repeat(hexLength)}` as const;
const candidateTargets = Object.freeze([
  Object.freeze({
    path: "src/example.ts",
    digest,
    byteLength: 1,
    bytes: Object.freeze([1]),
  }),
]);
const candidateDigest = digestValue([["src/example.ts", digest]]);
const bindings: PhysicalIntegrationBindings = Object.freeze({
  requestDigest: digest,
  repositoryId: "repo-a",
  treeDigest: digest,
  baselineDigest: digest,
  candidateDigest,
  provenanceDigest: digest,
});

describe("physical integration trust boundary", () => {
  it("passes only an opaque declaration and exact current bindings", async () => {
    const declaration = physicalDeclaration();
    let observed: unknown;
    const result = await attestPhysicalIntegration(
      {
        attest(input): unknown {
          observed = input;
          return { status: "accepted", receipt: receipt(bindings) };
        },
      },
      declaration,
      bindings,
      candidateTargets,
    );
    expect(result.status).toBe("accepted");
    expect(observed).toEqual({ declaration, bindings, candidateTargets });
  });

  it("rejects authority receipts with drifted bindings", async () => {
    const result = await attestPhysicalIntegration(
      {
        attest(): unknown {
          return {
            status: "accepted",
            receipt: receipt({ ...bindings, repositoryId: "repo-b" }),
          };
        },
      },
      physicalDeclaration(),
      bindings,
      candidateTargets,
    );
    expect(result).toEqual({
      status: "rejected",
      code: "INTEGRATION_REJECTED",
    });
  });

  it("rejects malformed evidence, digest drift, and authority exceptions", async () => {
    await expect(
      attestPhysicalIntegration(
        {
          attest(): unknown {
            return {
              status: "accepted",
              receipt: { ...receipt(bindings), receiptDigest: digest },
            };
          },
        },
        physicalDeclaration(),
        bindings,
        candidateTargets,
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "INTEGRATION_REJECTED",
    });
    await expect(
      attestPhysicalIntegration(
        {
          attest(): never {
            throw new Error("authority failed");
          },
        },
        Object.freeze({ opaque: true }),
        bindings,
        candidateTargets,
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "INTEGRATION_REJECTED",
    });
  });
});

function receipt(receiptBindings: PhysicalIntegrationBindings) {
  const targets = Object.freeze([
    Object.freeze({
      path: "src/example.ts",
      digest,
      byteLength: 1,
    }),
  ]);
  const targetSetDigest = digestValue([["src/example.ts", digest, 1]]);
  const workspaceIdentityDigest = digest;
  const candidate = Object.freeze({
    targetSetDigest,
    candidateDigest: receiptBindings.candidateDigest,
    workspaceIdentityDigest,
    provenanceMeasurementDigest: digestValue({
      declarationDigest: digest,
      manifestDigest: digest,
      profileDigest: digest,
      declaredProvenanceDigest: receiptBindings.provenanceDigest,
      workspaceIdentityDigest,
      targetSetDigest,
      candidateDigest: receiptBindings.candidateDigest,
    }),
    targets,
  });
  const material = Object.freeze({
    version: 1 as const,
    declarationDigest: digest,
    bindings: receiptBindings,
    owner: "owner-a",
    ownerKey: "owner-key-a",
    labId: "lab-a",
    composeProject: "compose-a",
    sourceRepositoryIdentity: "source-a",
    manifestPath: "/authority/manifest.json",
    manifestDigest: digest,
    readyState: "ready" as const,
    connections: Object.freeze([
      Object.freeze({
        name: "api",
        service: "web",
        target: 8080,
        scheme: "http",
      }),
    ]),
    endpoints: Object.freeze([
      Object.freeze({
        name: "api",
        service: "web",
        target: 8080,
        url: "http://127.0.0.1:8080",
      }),
    ]),
    candidate,
    probe: Object.freeze({
      profileId: "health",
      profileVersion: 1,
      profileDigest: digest,
      argv: Object.freeze(["bun", "run", "health"]),
      cwd: ".",
      environmentNames: Object.freeze([]),
      exitCode: 0,
      stdoutBytes: 2,
      stdoutDigest: digest,
      stderrBytes: 0,
      stderrDigest: digest,
      complete: true as const,
    }),
    cleanup: Object.freeze({
      destroyReported: true as const,
      labAbsent: true as const,
      terminal: true as const,
    }),
  });
  return Object.freeze({ ...material, receiptDigest: digestValue(material) });
}

function physicalDeclaration() {
  return Object.freeze({ declarationDigest: digest });
}
