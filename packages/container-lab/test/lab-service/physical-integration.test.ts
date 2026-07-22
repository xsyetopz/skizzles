// biome-ignore lint/correctness/noUnresolvedImports: Biome does not resolve Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  ContainerLabService,
  createPhysicalIntegrationAuthority,
  type PhysicalProbeProfile,
} from "../../src/lab/orchestrator.ts";
import { removeLabState, writeLab } from "../../src/state/lab/store.ts";
import { createLabServiceFixtureScope } from "./support.ts";

const digest = `sha256:${"0".repeat(64)}`;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const profile: PhysicalProbeProfile = Object.freeze({
  id: "http-health",
  version: 1,
  argv: Object.freeze(["bun", "run", "integration:probe"]),
  cwd: ".",
  environment: Object.freeze({}),
  timeoutSeconds: 30,
});
const fixtures = createLabServiceFixtureScope();

afterEach(fixtures.cleanup);

describe("physical integration authority", () => {
  it("structurally compatible services cannot mint physical declarations or receipts", async () => {
    const structuralMock = {
      owner: "owner",
      roots: { stateRoot: "/state", runtimeRoot: "/runtime" },
      run: () => Promise.resolve(0),
      destroyLab: () => Promise.resolve({ labId: "lab", destroyed: true }),
      listLabs: () => Promise.resolve({ labs: [] }),
    };
    const authority = createPhysicalIntegrationAuthority(structuralMock, [
      profile,
    ]);

    expect(await authority.declare(declarationInput())).toEqual({
      status: "rejected",
      code: "MOCKED_EVIDENCE_REJECTED",
    });
    expect(await authority.attest({ declaration: {}, bindings: {} })).toEqual({
      status: "rejected",
      code: "MOCKED_EVIDENCE_REJECTED",
    });

    class MockedService extends ContainerLabService {
      override run(): Promise<number> {
        return Promise.resolve(0);
      }
    }
    const subclassAuthority = createPhysicalIntegrationAuthority(
      new MockedService("owner"),
      [profile],
    );
    expect(await subclassAuthority.declare(declarationInput())).toEqual({
      status: "rejected",
      code: "MOCKED_EVIDENCE_REJECTED",
    });
  });

  it("rejects authentic services whose public fields or methods changed before authority creation", async () => {
    const changedMethod = new ContainerLabService("owner");
    Object.defineProperty(changedMethod, "run", {
      configurable: true,
      value: () => Promise.resolve(0),
    });
    expect(
      await createPhysicalIntegrationAuthority(changedMethod, [
        profile,
      ]).declare(declarationInput()),
    ).toEqual({
      status: "rejected",
      code: "MOCKED_EVIDENCE_REJECTED",
    });

    const changedIdentity = new ContainerLabService("owner");
    Object.defineProperty(changedIdentity, "owner", {
      configurable: true,
      value: "replacement-owner",
    });
    expect(
      await createPhysicalIntegrationAuthority(changedIdentity, [
        profile,
      ]).declare(declarationInput()),
    ).toEqual({
      status: "rejected",
      code: "MOCKED_EVIDENCE_REJECTED",
    });
  });

  it("declarations select a registered profile and cannot supply command material", async () => {
    const service = new ContainerLabService("owner", {
      stateRoot: "/definitely-missing-state",
      runtimeRoot: "/definitely-missing-runtime",
    });
    const authority = createPhysicalIntegrationAuthority(service, [profile]);

    expect(
      await authority.declare({
        ...declarationInput(),
        probe: {
          argv: ["sh", "-c", "caller controlled"],
          cwd: ".",
          environment: {},
          timeoutSeconds: 1,
        },
      }),
    ).toEqual({ status: "rejected", code: "INVALID_INPUT" });
    expect(
      await authority.declare({
        ...declarationInput(),
        probeProfileId: "unregistered",
      }),
    ).toEqual({ status: "rejected", code: "DECLARATION_REJECTED" });
  });

  it("invalid host profile registration fails closed before lab access", async () => {
    const service = new ContainerLabService("owner", {
      stateRoot: "/definitely-missing-state",
      runtimeRoot: "/definitely-missing-runtime",
    });
    const duplicateProfiles = [profile, { ...profile }];
    const authority = createPhysicalIntegrationAuthority(
      service,
      duplicateProfiles,
    );

    expect(await authority.declare(declarationInput())).toEqual({
      status: "rejected",
      code: "INVALID_INPUT",
    });
  });

  it("unknown labs and forged declarations fail closed without Docker", async () => {
    const service = new ContainerLabService("owner", {
      stateRoot: "/definitely-missing-state",
      runtimeRoot: "/definitely-missing-runtime",
    });
    const authority = createPhysicalIntegrationAuthority(service, [profile]);

    expect(await authority.declare(declarationInput())).toEqual({
      status: "rejected",
      code: "DECLARATION_REJECTED",
    });
    expect(
      await authority.attest({
        declaration: Object.freeze({ declarationDigest: digest }),
        bindings: validBindings(),
        candidateTargets: candidateTargets(),
      }),
    ).toEqual({ status: "rejected", code: "DECLARATION_REJECTED" });
  });

  it("issued declarations bind exact physical identities and immutable probe profiles", async () => {
    const { fixture, manifestDigest } = await physicalFixture();
    const service = new ContainerLabService(fixture.owner, fixture.roots);
    const authority = createPhysicalIntegrationAuthority(service, [profile]);
    const input = {
      ...declarationInput(),
      labId: fixture.lab.id,
      manifestDigest,
      connections: [
        { name: "http", service: "dev", target: 3000, scheme: "http" },
      ],
    };

    expect(
      await authority.declare({ ...input, manifestDigest: digest }),
    ).toEqual({ status: "rejected", code: "MANIFEST_MISMATCH" });
    expect(
      await authority.declare({
        ...input,
        connections: [
          { name: "http", service: "dev", target: 3001, scheme: "http" },
        ],
      }),
    ).toEqual({ status: "rejected", code: "ENDPOINT_MISMATCH" });

    const result = await authority.declare(input);
    expect(result.status).toBe("declared");
    if (result.status !== "declared") {
      throw new Error(`expected declaration, received ${result.code}`);
    }
    expect(result.declaration).toMatchObject({
      owner: fixture.owner,
      ownerKey: fixture.lab.ownerKey,
      labId: fixture.lab.id,
      composeProject: fixture.lab.composeProject,
      sourceRepositoryIdentity: fixture.lab.sourceRepositoryIdentity,
      manifestDigest,
      probe: {
        profileId: profile.id,
        profileVersion: profile.version,
        argv: profile.argv,
      },
    });
    expect(result.declaration.probe.profileDigest).toMatch(DIGEST_PATTERN);
    expect(result.declaration.declarationDigest).toMatch(DIGEST_PATTERN);
  });

  it("uses constructor-captured operations after prototype mutation", async () => {
    const { fixture, manifestDigest } = await physicalFixture();
    const service = new ContainerLabService(fixture.owner, fixture.roots);
    const authority = createPhysicalIntegrationAuthority(service, [profile]);
    const declared = await authority.declare({
      ...declarationInput(),
      labId: fixture.lab.id,
      manifestDigest,
      connections: [
        { name: "http", service: "dev", target: 3000, scheme: "http" },
      ],
    });
    if (declared.status !== "declared") {
      throw new Error(`expected declaration, received ${declared.code}`);
    }
    await removeLabState(
      fixture.roots.stateRoot,
      fixture.owner,
      fixture.lab.id,
    );
    const prototype = ContainerLabService.prototype;
    const originalRun = prototype.run;
    const originalDestroy = prototype.destroyLab;
    const originalList = prototype.listLabs;
    let fakeCalls = 0;
    prototype.run = () => {
      fakeCalls += 1;
      return Promise.resolve(0);
    };
    prototype.destroyLab = (labId: string) => {
      fakeCalls += 1;
      return Promise.resolve({ labId, destroyed: true });
    };
    prototype.listLabs = () => {
      fakeCalls += 1;
      return Promise.resolve({ labs: [] });
    };
    try {
      expect(
        await authority.attest({
          declaration: declared.declaration,
          bindings: validBindings(),
          candidateTargets: candidateTargets(),
        }),
      ).toEqual({ status: "rejected", code: "CLEANUP_REJECTED" });
      expect(fakeCalls).toBe(0);
      expect(() =>
        Object.defineProperty(service, "run", { value: prototype.run }),
      ).toThrow();
    } finally {
      prototype.run = originalRun;
      prototype.destroyLab = originalDestroy;
      prototype.listLabs = originalList;
    }
  });
});

async function physicalFixture() {
  const fixture = await fixtures.durableFixture("owner", "ready", true);
  const manifest = [
    "image: { name: node:24, service: dev }",
    "ports:",
    "  http: { service: dev, target: 3000, scheme: http }",
    "",
  ].join("\n");
  await writeFile(fixture.lab.manifestPath, manifest);
  fixture.lab.sourceRepositoryIdentity = "a".repeat(64);
  const runtime = fixture.lab.runtime;
  if (runtime === undefined) {
    throw new Error("ready fixture runtime is absent");
  }
  runtime.config.ports.push({
    name: "http",
    service: "dev",
    target: 3000,
    scheme: "http",
  });
  fixture.lab.endpoints.push({
    name: "http",
    service: "dev",
    target: 3000,
    url: "http://127.0.0.1:49152",
  });
  await writeLab(fixture.roots, fixture.lab);
  const manifestDigest = `sha256:${createHash("sha256")
    .update(await readFile(fixture.lab.manifestPath))
    .digest("hex")}`;
  return { fixture, manifestDigest };
}

function declarationInput(): Record<string, unknown> {
  return {
    version: 1,
    kind: "physical-integration",
    labId: "lab",
    manifestDigest: digest,
    connections: [
      { name: "http", service: "app", target: 3000, scheme: "http" },
    ],
    probeProfileId: profile.id,
  };
}

function validBindings(): Record<string, string> {
  return {
    requestDigest: digest,
    repositoryId: "repository",
    treeDigest: digest,
    baselineDigest: digest,
    candidateDigest: digest,
    provenanceDigest: digest,
  };
}

function candidateTargets(): readonly Readonly<{
  path: string;
  digest: string;
  byteLength: number;
  bytes: readonly number[];
}>[] {
  const bytes = Object.freeze([...Buffer.from("export {};\n")]);
  const candidateDigest = `sha256:${createHash("sha256")
    .update(Uint8Array.from(bytes))
    .digest("hex")}`;
  return Object.freeze([
    Object.freeze({
      path: "src/candidate.ts",
      digest: candidateDigest,
      byteLength: bytes.length,
      bytes,
    }),
  ]);
}
