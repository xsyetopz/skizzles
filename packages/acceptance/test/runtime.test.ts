import { describe, expect, it } from "bun:test";
import { digestValue, type VerificationDigest } from "../src/digest.ts";
import {
  createIndependentReviewer,
  createVerificationGate,
  isVerificationGateReceipt,
} from "../src/index.ts";
import { createGateFixture } from "./fixture.ts";

describe("verification gate", () => {
  it("accepts complete evidence, emits a bounded digest-only receipt, and replays", async () => {
    const fixture = createGateFixture();
    const result = await fixture.gate.evaluate(fixture.input);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(isVerificationGateReceipt(result.receipt)).toBe(true);
    expect(result.receipt).toMatchObject({
      taskId: fixture.input.taskId,
      taskEpochDigest: fixture.input.taskEpochDigest,
      rootIdentity: fixture.input.rootIdentity,
      candidateManifestDigest: fixture.input.candidateManifestDigest,
      modifiedNodeCount: 1,
      modifiedLineCount: 2,
      modifiedBranchCount: 1,
      mutantCount: 2,
      propertyCount: 1,
    });
    expect(JSON.stringify(result.receipt)).not.toContain("sourceText");
    expect(JSON.stringify(result.receipt)).not.toContain("candidateBytes");
    expect(fixture.calls.at(-1)).toBe("reviewer");

    fixture.calls.length = 0;
    const verification = await fixture.gate.verify(
      Object.freeze({ receipt: result.receipt, evaluation: fixture.input }),
    );
    expect(verification).toMatchObject({
      status: "valid",
      receiptDigest: result.receipt.receiptDigest,
    });
    expect(fixture.calls.at(-1)).toBe("reviewer");
  });

  it("rejects omitted and divergent candidate manifests before review", async () => {
    const omittedInput = createGateFixture();
    const {
      candidateManifestDigest: _omittedCandidateManifestDigest,
      ...inputWithoutManifest
    } = omittedInput.input;
    expect(
      await omittedInput.gate.evaluate(Object.freeze(inputWithoutManifest)),
    ).toMatchObject({ status: "rejected", code: "INVALID_INPUT" });
    expect(omittedInput.calls).toHaveLength(0);

    const forgedInput = createGateFixture();
    expect(
      await forgedInput.gate.evaluate(
        Object.freeze({
          ...forgedInput.input,
          candidateManifestDigest: digestValue("forged-input-manifest"),
        }),
      ),
    ).toMatchObject({
      status: "rejected",
      code: "SOURCE_EVIDENCE_REJECTED",
    });
    expect(forgedInput.calls).not.toContain("reviewer");

    for (const sourceManifest of ["omitted", "forged"] as const) {
      const source = createGateFixture();
      source.modes.sourceManifest = sourceManifest;
      expect(await source.gate.evaluate(source.input)).toMatchObject({
        status: "rejected",
        code: "SOURCE_EVIDENCE_REJECTED",
      });
      expect(source.calls).not.toContain("reviewer");
    }

    for (const assuranceManifest of [
      "omitted",
      "forged",
      "reordered",
    ] as const) {
      const assurance = createGateFixture();
      assurance.modes.assuranceManifest = assuranceManifest;
      expect(await assurance.gate.evaluate(assurance.input)).toMatchObject({
        status: "rejected",
        code: "CHANGE_ASSURANCE_REJECTED",
      });
      expect(assurance.calls).not.toContain("reviewer");
    }

    for (const taskManifest of ["omitted", "forged"] as const) {
      const task = createGateFixture();
      task.modes.taskManifest = taskManifest;
      expect(await task.gate.evaluate(task.input)).toMatchObject({
        status: "rejected",
        code: "TASK_WORKTREE_REJECTED",
      });
      expect(task.calls).not.toContain("reviewer");
    }

    const mixedProfiles = createGateFixture();
    mixedProfiles.modes.mixedProfileManifests = true;
    expect(
      await mixedProfiles.gate.evaluate(mixedProfiles.input),
    ).toMatchObject({
      status: "rejected",
      code: "TASK_WORKTREE_REJECTED",
    });
    expect(mixedProfiles.calls).not.toContain("reviewer");
  });

  for (const [outcome, code] of [
    ["survived", "MUTATION_SURVIVED"],
    ["timeout", "MUTATION_TIMEOUT"],
  ] as const) {
    it(`rejects a ${outcome} mutant even when the reviewer accepts`, async () => {
      const fixture = createGateFixture();
      fixture.modes.mutation = outcome;
      const result = await fixture.gate.evaluate(fixture.input);
      expect(result).toMatchObject({ status: "rejected", code });
      expect(fixture.calls.at(-1)).toBe("reviewer");
    });
  }

  it("requires an exact independent exclusion for invalid mutants", async () => {
    const fixture = createGateFixture();
    fixture.modes.mutation = "invalid";
    expect(await fixture.gate.evaluate(fixture.input)).toMatchObject({
      status: "rejected",
      code: "MUTATION_INVALID",
    });
    expect(fixture.calls).toContain("exclusion");

    fixture.modes.excludeInvalid = true;
    expect(await fixture.gate.evaluate(fixture.input)).toMatchObject({
      status: "accepted",
    });
  });

  it("rejects a mutation report that omits one authenticated site variant", async () => {
    const fixture = createGateFixture((request) => {
      const payload = request.payload as Readonly<{
        inventory: readonly Readonly<{ mutantId: VerificationDigest }>[];
        inventoryDigest: VerificationDigest;
      }>;
      const first = payload.inventory[0];
      if (first === undefined) throw new Error("expected mutation inventory");
      return Object.freeze({
        status: "valid",
        bindingDigest: request.bindingDigest,
        evidenceDigest: digestValue("incomplete-mutation-report"),
        inventoryDigest: payload.inventoryDigest,
        profileReceiptDigest: digestValue("profile-mutation"),
        outcomes: Object.freeze([
          Object.freeze({
            mutantId: first.mutantId,
            outcome: "killed",
            evidenceDigest: digestValue("first-variant-killed"),
          }),
        ]),
      });
    });
    expect(await fixture.gate.evaluate(fixture.input)).toMatchObject({
      status: "rejected",
      code: "MUTATION_INVENTORY_REJECTED",
    });
  });

  it("rejects original-baseline drift, property counterexamples, and modified coverage gaps", async () => {
    const baseline = createGateFixture();
    baseline.modes.originalPassed = false;
    expect(await baseline.gate.evaluate(baseline.input)).toMatchObject({
      status: "rejected",
      code: "ORIGINAL_TESTS_REJECTED",
    });

    const property = createGateFixture();
    property.modes.propertyCounterexample = true;
    expect(await property.gate.evaluate(property.input)).toMatchObject({
      status: "rejected",
      code: "PROPERTY_COUNTEREXAMPLE",
    });

    const coverage = createGateFixture();
    coverage.modes.nodeHits = 1;
    coverage.modes.branchHits = 0;
    const result = await coverage.gate.evaluate(coverage.input);
    expect(result).toMatchObject({
      status: "rejected",
      code: "MODIFIED_NODE_UNCOVERED",
    });
    if (result.status === "rejected") {
      expect(result.failures).toContain("MODIFIED_BRANCH_UNCOVERED");
    }
  });

  it("rejects an original-test report from a different production overlay", async () => {
    const fixture = createGateFixture();
    fixture.modes.originalOverlayDrift = true;
    expect(await fixture.gate.evaluate(fixture.input)).toMatchObject({
      status: "rejected",
      code: "AUTHORITY_REJECTED",
    });
    expect(fixture.calls).not.toContain("mutation");
    expect(fixture.calls).not.toContain("reviewer");
  });

  it("requires an exact complete modified-line report at the host threshold", async () => {
    for (const lineHits of [0, 1]) {
      const belowThreshold = createGateFixture();
      belowThreshold.modes.lineHits = lineHits;
      expect(
        await belowThreshold.gate.evaluate(belowThreshold.input),
      ).toMatchObject({
        status: "rejected",
        code: "MODIFIED_LINE_UNCOVERED",
      });
      expect(belowThreshold.calls.at(-1)).toBe("reviewer");
    }

    const exactThreshold = createGateFixture();
    exactThreshold.modes.lineHits =
      exactThreshold.config.coverage.minimumLineHits;
    expect(
      await exactThreshold.gate.evaluate(exactThreshold.input),
    ).toMatchObject({ status: "accepted" });

    const omitted = createGateFixture();
    omitted.modes.omitCoverageLine = true;
    expect(await omitted.gate.evaluate(omitted.input)).toMatchObject({
      status: "rejected",
      code: "COVERAGE_REJECTED",
    });
    expect(omitted.calls.at(-1)).toBe("reviewer");

    const forged = createGateFixture();
    forged.modes.forgeCoverageLine = true;
    expect(await forged.gate.evaluate(forged.input)).toMatchObject({
      status: "rejected",
      code: "COVERAGE_REJECTED",
    });
    expect(forged.calls.at(-1)).toBe("reviewer");

    const forgedObjective = createGateFixture();
    forgedObjective.modes.forgeCoverageObjectiveDigest = true;
    expect(
      await forgedObjective.gate.evaluate(forgedObjective.input),
    ).toMatchObject({
      status: "rejected",
      code: "COVERAGE_REJECTED",
    });
    expect(forgedObjective.calls.at(-1)).toBe("reviewer");
  });

  it("derives a non-self-referential coverage objective after task evidence", async () => {
    const fixture = createGateFixture();
    expect(await fixture.gate.evaluate(fixture.input)).toMatchObject({
      status: "accepted",
    });
    expect(fixture.calls.indexOf("task-worktree")).toBeLessThan(
      fixture.calls.indexOf("coverage"),
    );
    const objective = fixture.coveragePayloads[0] as Readonly<{
      structuralReceiptDigest: VerificationDigest;
      profileReceiptDigest: VerificationDigest;
      modifiedNodes: readonly object[];
      thresholds: object;
      coverageObjectiveDigest: VerificationDigest;
    }>;
    const { coverageObjectiveDigest, ...material } = objective;
    expect(objective.profileReceiptDigest).toBe(
      digestValue("profile-coverage"),
    );
    expect(coverageObjectiveDigest).toBe(digestValue(material));
  });

  it("rejects incomplete fuzz execution despite a valid seed schedule", async () => {
    const shortRun = createGateFixture();
    shortRun.modes.propertyExecutedCases = 128;
    expect(await shortRun.gate.evaluate(shortRun.input)).toMatchObject({
      status: "rejected",
      code: "PROPERTY_REJECTED",
    });

    const noExtremes = createGateFixture();
    noExtremes.modes.propertyExecutedExtremes = false;
    expect(await noExtremes.gate.evaluate(noExtremes.input)).toMatchObject({
      status: "rejected",
      code: "PROPERTY_REJECTED",
    });
    expect(noExtremes.calls.at(-1)).toBe("reviewer");
  });

  it("rejects incomplete property reach and oversized task artifacts", async () => {
    const property = createGateFixture();
    property.modes.propertyReachesNode = false;
    property.modes.propertyReachesBranch = false;
    const result = await property.gate.evaluate(property.input);
    expect(result).toMatchObject({
      status: "rejected",
      code: "MODIFIED_NODE_UNCOVERED",
    });

    const artifact = createGateFixture();
    artifact.modes.artifactBytes = 1_000_001;
    expect(await artifact.gate.evaluate(artifact.input)).toMatchObject({
      status: "rejected",
      code: "TASK_WORKTREE_REJECTED",
    });
  });

  it("does not invoke accessors or accept proxies at trust boundaries", async () => {
    const fixture = createGateFixture();
    let invoked = false;
    const accessor = Object.freeze(
      Object.defineProperty({}, "version", {
        enumerable: true,
        get: () => {
          invoked = true;
          return 1;
        },
      }),
    );
    expect(await fixture.gate.evaluate(accessor)).toMatchObject({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(invoked).toBe(false);
    expect(
      await fixture.gate.evaluate(new Proxy(fixture.input, {})),
    ).toMatchObject({
      status: "rejected",
      code: "INVALID_INPUT",
    });
  });

  it("rejects authority reuse and reviewer callback reuse", () => {
    const callback = () => Object.freeze({});
    const reviewer = createIndependentReviewer(
      Object.freeze({ id: "reviewer-a", evaluate: callback }),
    );
    const secondReviewer = createIndependentReviewer(
      Object.freeze({ id: "reviewer-b", evaluate: callback }),
    );
    expect(reviewer.status).toBe("created");
    expect(secondReviewer.status).toBe("created");

    const fixture = createGateFixture();
    if (reviewer.status !== "created" || secondReviewer.status !== "created") {
      return;
    }
    const invalid = Object.freeze({
      ...fixture.config,
      exclusions: reviewer.authority as never,
      reviewer: secondReviewer.authority,
    });
    expect(createVerificationGate(invalid)).toEqual({
      status: "rejected",
      code: "INVALID_CONFIG",
    });
  });

  it("rejects forged and cross-gate receipts during replay", async () => {
    const first = createGateFixture();
    const second = createGateFixture();
    const result = await first.gate.evaluate(first.input);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    const forged = Object.freeze({ ...result.receipt });
    expect(
      await first.gate.verify(
        Object.freeze({ receipt: forged, evaluation: first.input }),
      ),
    ).toMatchObject({ status: "rejected", code: "REPLAY_REJECTED" });
    expect(
      await second.gate.verify(
        Object.freeze({ receipt: result.receipt, evaluation: second.input }),
      ),
    ).toMatchObject({ status: "rejected", code: "REPLAY_REJECTED" });
  });
});
