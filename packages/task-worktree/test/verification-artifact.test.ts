// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { afterEach, describe, expect, it } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestTaskWorktreeValue } from "../src/digest.ts";
import { readVerificationArtifact } from "../src/verification/artifact.ts";

const fixtures: string[] = [];
const nodeId = digestTaskWorktreeValue("node-a");
const branchId = digestTaskWorktreeValue("branch-a");
const lineIds = Object.freeze([
  digestTaskWorktreeValue("line-a"),
  digestTaskWorktreeValue("line-b"),
]);
const extremeVectorDigests = Object.freeze([
  digestTaskWorktreeValue("extreme-vector-a"),
]);
const extremeVectorInventoryDigest =
  digestTaskWorktreeValue(extremeVectorDigests);
const profile = Object.freeze({
  kind: "original-tests" as const,
  artifact: Object.freeze({
    schema: "fixture.artifact",
    relativePath: "verification/result.json",
    maximumBytes: 4096,
  }),
});
const originalObjective = Object.freeze({
  kind: "original-tests" as const,
  structuralReceiptDigest: digestTaskWorktreeValue("structural"),
  baselineTestManifestDigest: digestTaskWorktreeValue("baseline-tests"),
  productionOverlayDigest: digestTaskWorktreeValue("production-overlay"),
  containerImageDigest: digestTaskWorktreeValue("container-image"),
  containerEvidenceDigest: digestTaskWorktreeValue("container-evidence"),
});
const originalBinding = Object.freeze({
  objective: originalObjective,
  objectiveDigest: digestTaskWorktreeValue(originalObjective),
});

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("verification artifact ingestion", () => {
  it("accepts only exact bounded structured JSON", async () => {
    const root = await fixture();
    await writeFile(
      join(root, profile.artifact.relativePath),
      JSON.stringify({
        schema: profile.artifact.schema,
        result: {
          kind: "original-tests",
          outcome: "passed",
          passedCount: 2,
          failedCount: 0,
          testIds: ["test-a", "test-b"],
          baselineTestManifestDigest:
            originalObjective.baselineTestManifestDigest,
          productionOverlayDigest: originalObjective.productionOverlayDigest,
          containerImageDigest: originalObjective.containerImageDigest,
          containerEvidenceDigest: originalObjective.containerEvidenceDigest,
        },
      }),
    );
    const artifact = await readVerificationArtifact(
      root,
      profile,
      originalBinding,
    );
    expect(artifact).toMatchObject({
      artifactSchema: profile.artifact.schema,
      report: {
        kind: "original-tests",
        outcome: "passed",
        passedCount: 2,
        failedCount: 0,
        testIds: ["test-a", "test-b"],
        baselineTestManifestDigest:
          originalObjective.baselineTestManifestDigest,
        productionOverlayDigest: originalObjective.productionOverlayDigest,
        containerImageDigest: originalObjective.containerImageDigest,
        containerEvidenceDigest: originalObjective.containerEvidenceDigest,
      },
    });
    expect(artifact).not.toHaveProperty("value");
    expect(Object.isFrozen(artifact?.report)).toBe(true);
  });

  it("rejects symlinks, hard links, and root-bearing artifact values", async () => {
    const outside = await fixture();
    const outsideFile = join(outside, "outside.json");
    await writeFile(outsideFile, validJson());

    const symlinkRoot = await fixture();
    await symlink(
      outsideFile,
      join(symlinkRoot, profile.artifact.relativePath),
    );
    expect(
      await readVerificationArtifact(symlinkRoot, profile, originalBinding),
    ).toBeUndefined();

    const hardlinkRoot = await fixture();
    await link(outsideFile, join(hardlinkRoot, profile.artifact.relativePath));
    expect(
      await readVerificationArtifact(hardlinkRoot, profile, originalBinding),
    ).toBeUndefined();

    const leakRoot = await fixture();
    await writeFile(
      join(leakRoot, profile.artifact.relativePath),
      JSON.stringify({
        schema: profile.artifact.schema,
        result: {
          kind: "original-tests",
          outcome: "passed",
          passedCount: 1,
          failedCount: 0,
          testIds: ["test-a"],
          baselineTestManifestDigest:
            originalObjective.baselineTestManifestDigest,
          productionOverlayDigest: originalObjective.productionOverlayDigest,
          containerImageDigest: originalObjective.containerImageDigest,
          containerEvidenceDigest: originalObjective.containerEvidenceDigest,
          detail: "const productionSecret = 'never publish me'",
        },
      }),
    );
    expect(
      await readVerificationArtifact(leakRoot, profile, originalBinding),
    ).toBeUndefined();
  });

  it("retains only exact source-free mutation, property, and coverage evidence", async () => {
    const reports = [
      {
        kind: "mutation" as const,
        outcome: "passed" as const,
        inventoryDigest: digestTaskWorktreeValue("inventory"),
        outcomes: [
          {
            mutantId: digestTaskWorktreeValue("mutant-a"),
            outcome: "killed" as const,
            evidenceDigest: digestTaskWorktreeValue("mutant-a-evidence"),
          },
        ],
      },
      {
        kind: "property" as const,
        outcome: "passed" as const,
        seedScheduleDigest: digestTaskWorktreeValue("seed-schedule"),
        requiredCaseCount: 129,
        extremeVectorInventoryDigest,
        properties: [
          {
            propertyId: "property-a",
            nodeIds: [nodeId],
            branchIds: [branchId],
            completed: true as const,
            executedCases: 129,
            executedRandomCases: 128,
            executedExtremeCases: 1,
            executedExtremeVectorDigests: extremeVectorDigests,
            counterexampleDigest: null,
          },
        ],
      },
      {
        kind: "coverage" as const,
        outcome: "passed" as const,
        nodes: [
          {
            nodeId,
            hits: 4,
            lines: lineIds.map((lineId) => ({ lineId, hits: 2 })),
            branches: [{ branchId, hits: 3 }],
          },
        ],
      },
    ];
    for (const report of reports) {
      const root = await fixture();
      const evidenceProfile = Object.freeze({
        kind: report.kind,
        artifact: profile.artifact,
      });
      const objective =
        report.kind === "mutation"
          ? Object.freeze({
              kind: report.kind,
              structuralReceiptDigest: digestTaskWorktreeValue("structural"),
              inventoryDigest: report.inventoryDigest,
              mutantIds: Object.freeze(
                report.outcomes.map(({ mutantId }) => mutantId),
              ),
            })
          : report.kind === "property"
            ? Object.freeze({
                kind: report.kind,
                structuralReceiptDigest: digestTaskWorktreeValue("structural"),
                seedScheduleDigest: report.seedScheduleDigest,
                requiredRandomFuzzCaseCount: 128,
                requiredExtremeVectorCount: 1,
                requiredCaseCount: report.requiredCaseCount,
                requiredExtremeVectorDigests: extremeVectorDigests,
                extremeVectorInventoryDigest:
                  report.extremeVectorInventoryDigest,
                nodeIds: Object.freeze([nodeId]),
                branchIds: Object.freeze([branchId]),
              })
            : Object.freeze({
                kind: report.kind,
                structuralReceiptDigest: digestTaskWorktreeValue("structural"),
                modifiedNodes: Object.freeze([
                  Object.freeze({
                    nodeId,
                    lineIds,
                    branchIds: Object.freeze([branchId]),
                  }),
                ]),
                thresholds: Object.freeze({
                  minimumNodeHits: 2,
                  minimumLineHits: 2,
                  minimumBranchHits: 2,
                }),
              });
      await writeFile(
        join(root, evidenceProfile.artifact.relativePath),
        JSON.stringify({
          schema: evidenceProfile.artifact.schema,
          result: report,
        }),
      );
      const artifact = await readVerificationArtifact(
        root,
        evidenceProfile,
        Object.freeze({
          objective,
          objectiveDigest: digestTaskWorktreeValue(objective),
        }),
      );
      expect(artifact?.report).toEqual(report);
      expect(Object.isFrozen(artifact?.report)).toBe(true);
      if (artifact?.report.kind === "mutation")
        expect(Object.isFrozen(artifact.report.outcomes[0])).toBe(true);
      if (artifact?.report.kind === "property")
        expect(Object.isFrozen(artifact.report.properties[0])).toBe(true);
      if (artifact?.report.kind === "coverage") {
        expect(Object.isFrozen(artifact.report.nodes[0])).toBe(true);
        expect(Object.isFrozen(artifact.report.nodes[0]?.branches[0])).toBe(
          true,
        );
      }
    }
  });

  it("requires one exact line-hit record per authenticated modified line", async () => {
    const coverageProfile = Object.freeze({
      kind: "coverage" as const,
      artifact: profile.artifact,
    });
    const objective = Object.freeze({
      kind: "coverage" as const,
      structuralReceiptDigest: digestTaskWorktreeValue("structural"),
      modifiedNodes: Object.freeze([
        Object.freeze({
          nodeId,
          lineIds,
          branchIds: Object.freeze([branchId]),
        }),
      ]),
      thresholds: Object.freeze({
        minimumNodeHits: 2,
        minimumLineHits: 2,
        minimumBranchHits: 2,
      }),
    });
    const binding = Object.freeze({
      objective,
      objectiveDigest: digestTaskWorktreeValue(objective),
    });
    const firstLine = lineIds[0];
    const secondLine = lineIds[1];
    if (firstLine === undefined || secondLine === undefined)
      throw new Error("line fixture missing");
    const invalidLines = [
      [{ lineId: firstLine, hits: 2 }],
      [
        { lineId: firstLine, hits: 2 },
        { lineId: firstLine, hits: 2 },
      ],
      [
        { lineId: firstLine, hits: 2 },
        { lineId: digestTaskWorktreeValue("unknown-line"), hits: 2 },
      ],
    ];
    for (const lines of invalidLines) {
      const root = await fixture();
      await writeFile(
        join(root, coverageProfile.artifact.relativePath),
        coverageJson(lines),
      );
      expect(
        await readVerificationArtifact(root, coverageProfile, binding),
      ).toBeUndefined();
    }
    for (const hits of [1, 2]) {
      const root = await fixture();
      await writeFile(
        join(root, coverageProfile.artifact.relativePath),
        coverageJson([
          { lineId: firstLine, hits },
          { lineId: secondLine, hits },
        ]),
      );
      const artifact = await readVerificationArtifact(
        root,
        coverageProfile,
        binding,
      );
      expect(artifact?.report).toMatchObject({
        kind: "coverage",
        nodes: [{ lines: [{ hits }, { hits }] }],
      });
    }
  });
});

async function fixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "skizzles-verification-artifact-")),
  );
  fixtures.push(root);
  await mkdir(join(root, "verification"));
  return root;
}

function validJson(): string {
  return JSON.stringify({
    schema: profile.artifact.schema,
    result: {
      kind: "original-tests",
      outcome: "passed",
      passedCount: 1,
      failedCount: 0,
      testIds: ["test-a"],
      baselineTestManifestDigest: originalObjective.baselineTestManifestDigest,
      productionOverlayDigest: originalObjective.productionOverlayDigest,
      containerImageDigest: originalObjective.containerImageDigest,
      containerEvidenceDigest: originalObjective.containerEvidenceDigest,
    },
  });
}

function coverageJson(
  lines: readonly Readonly<{ lineId: `sha256:${string}`; hits: number }>[],
): string {
  return JSON.stringify({
    schema: profile.artifact.schema,
    result: {
      kind: "coverage",
      outcome: "passed",
      nodes: [
        {
          nodeId,
          hits: 2,
          lines,
          branches: [{ branchId, hits: 2 }],
        },
      ],
    },
  });
}
