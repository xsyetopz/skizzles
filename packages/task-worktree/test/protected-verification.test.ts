import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTaskWorktree,
  digestTaskWorktreeValue,
  isTaskWorktreeVerificationReceipt,
  type TaskWorktreeProtectedPathAuthorizationRequest,
} from "../src/index.ts";
import {
  cleanupFixtures,
  policyConfig,
  worktreePaths,
} from "./lifecycle/support.ts";
import {
  createProtectedAuthority,
  declaration,
  multiDeclaration,
  protectedConfig,
  protectedFixture,
  verificationObjective,
} from "./verification-fixture.ts";

afterEach(cleanupFixtures);

describe("protected task paths", () => {
  it("requires nonempty specification roots and test roots for verification", async () => {
    const fixture = await protectedFixture();
    const base = protectedConfig(fixture, "implementation", undefined, true);
    expect(
      createTaskWorktree(
        Object.freeze({
          ...base,
          protectedPaths: Object.freeze({
            ...base.protectedPaths,
            specificationRoots: Object.freeze([]),
          }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_CONFIG" });
    expect(
      createTaskWorktree(
        Object.freeze({
          ...base,
          protectedPaths: Object.freeze({
            ...base.protectedPaths,
            testRoots: Object.freeze([]),
          }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_CONFIG" });
  });

  it("rejects missing and empty protected roots before writing", async () => {
    const fixture = await protectedFixture();
    const base = protectedConfig(fixture, "implementation");
    for (const specificationRoot of ["missing-spec", "empty-spec"]) {
      if (specificationRoot === "empty-spec") {
        await mkdir(join(fixture.repository, specificationRoot));
      }
      const created = createTaskWorktree(
        Object.freeze({
          ...base,
          authorityId: `root-${specificationRoot}`,
          protectedPaths: Object.freeze({
            ...base.protectedPaths,
            specificationRoots: Object.freeze([specificationRoot]),
          }),
        }),
      );
      expect(created.status).toBe("created");
      if (created.status !== "created") continue;
      expect(
        await created.taskWorktree.prepare(
          declaration("src/value.ts", "baseline production\n", "changed\n"),
        ),
      ).toEqual({ status: "rejected", code: "CANDIDATE_REJECTED" });
      expect(
        await readFile(join(fixture.repository, "src/value.ts"), "utf8"),
      ).toBe("baseline production\n");
    }
  });

  it("rejects normative specification changes in implementation mode before writing", async () => {
    const fixture = await protectedFixture();
    const authority = createProtectedAuthority(fixture, "implementation");
    const result = await authority.prepare(
      declaration("spec/rules.md", "normative\n", "rewritten\n"),
    );
    expect(result).toEqual({ status: "rejected", code: "CANDIDATE_REJECTED" });
    expect(
      await readFile(join(fixture.repository, "spec/rules.md"), "utf8"),
    ).toBe("normative\n");
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
  });

  it("requires an exact host decision for the canonical test path set", async () => {
    const fixture = await protectedFixture();
    let observed: TaskWorktreeProtectedPathAuthorizationRequest | undefined;
    const authority = createProtectedAuthority(
      fixture,
      "implementation",
      (request) => {
        observed = request;
        return Object.freeze({
          status: "authorized" as const,
          requestDigest: request.requestDigestOfThisMaterial,
          mode: "implementation" as const,
          authorizedTestPaths: request.testPaths,
          authorizationDigest: digestTaskWorktreeValue("test-authorization"),
        });
      },
    );
    const result = await authority.prepare(
      declaration("test/value.test.ts", "baseline test\n", "candidate test\n"),
    );
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("candidate rejected");
    expect(observed).toEqual(
      expect.objectContaining({
        taskId: "protected-task",
        taskEpochDigest: digestTaskWorktreeValue("epoch-1"),
        repositoryId: "repo-a",
        rootIdentity: "root-a",
        testPaths: ["test/value.test.ts"],
        specificationPaths: [],
      }),
    );
    expect(Object.isFrozen(observed)).toBe(true);
    expect(
      await authority.revalidate(
        Object.freeze({ version: 1 as const, session: result.session }),
      ),
    ).toMatchObject({ status: "valid" });
    expect(
      await authority.close(
        Object.freeze({ version: 1 as const, session: result.session }),
      ),
    ).toMatchObject({ status: "closed" });
  });

  it("rejects case aliases and mismatched authorized test sets", async () => {
    const fixture = await protectedFixture();
    const alias = createProtectedAuthority(fixture, "implementation");
    expect(
      await alias.prepare(declaration("Test/alias.ts", null, "alias\n")),
    ).toEqual({ status: "rejected", code: "CANDIDATE_REJECTED" });
    const mismatch = createProtectedAuthority(
      fixture,
      "implementation",
      (request) =>
        Object.freeze({
          status: "authorized" as const,
          requestDigest: request.requestDigestOfThisMaterial,
          mode: "implementation" as const,
          authorizedTestPaths: Object.freeze([]),
          authorizationDigest: digestTaskWorktreeValue("wrong-path-set"),
        }),
    );
    expect(
      await mismatch.prepare(
        declaration(
          "test/value.test.ts",
          "baseline test\n",
          "candidate test\n",
          "epoch-2",
        ),
      ),
    ).toEqual({ status: "rejected", code: "CANDIDATE_REJECTED" });
  });

  it("admits specification-only design tasks and rejects mixed implementation paths", async () => {
    const fixture = await protectedFixture();
    const design = createProtectedAuthority(fixture, "design");
    const prepared = await design.prepare(
      declaration("spec/rules.md", "normative\n", "designed\n"),
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("design task rejected");
    expect(
      await design.close(
        Object.freeze({ version: 1 as const, session: prepared.session }),
      ),
    ).toMatchObject({ status: "closed" });
    const mixed = createProtectedAuthority(fixture, "design");
    expect(
      await mixed.prepare(
        declaration(
          "src/value.ts",
          "baseline production\n",
          "candidate production\n",
          "epoch-2",
        ),
      ),
    ).toEqual({ status: "rejected", code: "CANDIDATE_REJECTED" });
  });
});

describe("authenticated verification views", () => {
  it("rejects original tests without container user-namespace isolation", async () => {
    const fixture = await protectedFixture();
    const base = protectedConfig(fixture, "implementation", undefined, true);
    const created = createTaskWorktree(
      Object.freeze({ ...base, sandbox: policyConfig().sandbox }),
    );
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    const prepared = await created.taskWorktree.prepare(multiDeclaration());
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(
      await created.taskWorktree.executeVerification(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          profileId: "original-tests",
          objective: verificationObjective("original-tests"),
        }),
      ),
    ).toEqual({ status: "rejected", code: "VERIFICATION_REJECTED" });
  });

  it("executes baseline tests and candidate tests in distinct exact views and authenticates artifacts", async () => {
    const fixture = await protectedFixture();
    const authority = createProtectedAuthority(
      fixture,
      "implementation",
      undefined,
      true,
    );
    const input = multiDeclaration();
    const prepared = await authority.prepare(input);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      return;
    }
    expect(prepared.receipt.baselineTestManifestDigest).not.toBe(
      prepared.receipt.candidateTestManifestDigest,
    );
    expect(prepared.receipt.specificationLockDigest).toMatch(/^sha256:/u);
    const original = await authority.executeVerification(
      Object.freeze({
        version: 1 as const,
        session: prepared.session,
        profileId: "original-tests",
        objective: verificationObjective("original-tests"),
      }),
    );
    expect(original.status).toBe("verified");
    if (original.status !== "verified") {
      return;
    }
    expect(isTaskWorktreeVerificationReceipt(original.receipt)).toBe(true);
    expect(original.receipt).not.toHaveProperty("root");
    expect(original.receipt).not.toHaveProperty("physicalEvidenceDigest");
    expect(original.receipt).not.toHaveProperty("protectedManifestDigest");
    expect(original.receipt.baselineTestManifestDigest).not.toBe(
      original.receipt.candidateTestManifestDigest,
    );
    expect(original.receipt.baselineTestManifestDigest).toBe(
      prepared.receipt.baselineTestManifestDigest,
    );
    expect(original.receipt.candidateManifestDigest).toBe(
      prepared.receipt.candidateManifestDigest,
    );
    expect(original.receipt.specificationLockDigest).toBe(
      prepared.receipt.specificationLockDigest,
    );
    expect(original.receipt.artifact).not.toHaveProperty("value");
    expect(original.receipt.artifact.report).toEqual({
      kind: "original-tests",
      outcome: "passed",
      passedCount: 2,
      failedCount: 0,
      testIds: ["test-a", "test-b"],
      baselineTestManifestDigest: original.receipt.baselineTestManifestDigest,
      productionOverlayDigest: original.receipt.viewReceiptDigest,
      containerImageDigest: digestTaskWorktreeValue("container-image"),
      containerEvidenceDigest: expect.stringMatching(/^sha256:/u),
    });
    expect(original.receipt.isolation).toMatchObject({
      mechanism: "container-user-namespace",
      containerImageDigest: digestTaskWorktreeValue("container-image"),
    });
    expect(original.receipt.objectiveDigest).toBe(
      original.receipt.artifact.objectiveDigest,
    );
    expect(
      await authority.verifyVerificationReceipt(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          receipt: original.receipt,
        }),
      ),
    ).toBe(true);

    const candidate = await authority.executeVerification(
      Object.freeze({
        version: 1 as const,
        session: prepared.session,
        profileId: "candidate-tests",
        objective: verificationObjective("property"),
      }),
    );
    expect(candidate.status).toBe("verified");
    if (candidate.status !== "verified") {
      return;
    }
    expect(candidate.receipt.viewReceiptDigest).not.toBe(
      original.receipt.viewReceiptDigest,
    );
    expect(candidate.receipt.specificationLockDigest).toBe(
      original.receipt.specificationLockDigest,
    );
    expect(
      await authority.verifyVerificationReceipt(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          receipt: { ...candidate.receipt },
        }),
      ),
    ).toBe(false);
    const coverageObjective = verificationObjective("coverage");
    expect(coverageObjective).not.toHaveProperty("profileReceiptDigest");
    expect(coverageObjective).not.toHaveProperty("coverageObjectiveDigest");
    const coverage = await authority.executeVerification(
      Object.freeze({
        version: 1 as const,
        session: prepared.session,
        profileId: "coverage",
        objective: coverageObjective,
      }),
    );
    expect(coverage.status).toBe("verified");
    if (coverage.status !== "verified") return;
    expect(coverage.receipt.objectiveDigest).toBe(
      coverage.receipt.artifact.objectiveDigest,
    );
    expect(coverage.receipt.artifact.report).toMatchObject({
      kind: "coverage",
      nodes: [
        {
          hits: 2,
          lines: [{ hits: 2 }, { hits: 2 }],
          branches: [{ hits: 2 }],
        },
      ],
    });
    expect(
      await authority.verifyVerificationReceipt(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          receipt: coverage.receipt,
        }),
      ),
    ).toBe(true);
    expect(
      await authority.close(
        Object.freeze({ version: 1 as const, session: prepared.session }),
      ),
    ).toMatchObject({ status: "closed" });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
  });
});
