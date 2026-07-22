// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { createEngineeringWorkflow } from "../../src/engineering/workflow.ts";
import {
  candidate,
  createFixture,
  digest,
  replacement,
  targetPath,
} from "./source-fixture.ts";

describe("engineering workflow with the real source engine", () => {
  it("drives describe and every cursor step before awaiting approval", async () => {
    const fixture = await createFixture();
    try {
      const described = await fixture.workflow.describe({
        ...fixture.repository,
        targets: [targetPath],
        validationProfile: "strict",
      });
      expect(described.status).toBe("described");
      if (described.status !== "described") {
        throw new Error(`describe failed: ${described.code}`);
      }
      const target = described.context.targets.find(
        (entry) => entry.path === targetPath,
      );
      const declaration = target?.declarations.find(
        (entry) =>
          entry.declarationKind === "function" && entry.name === "value",
      );
      if (declaration === undefined) {
        throw new Error("described declaration missing");
      }

      const prepared = await fixture.workflow.prepare({
        ...fixture.repository,
        context: described.context,
        targets: [
          {
            path: targetPath,
            operations: [
              {
                kind: "replace",
                selector: {
                  declarationKind: "function",
                  name: "value",
                  expectedNodeDigest: declaration.nodeDigest,
                },
                templateId: "typescript-function",
                nodeSource: replacement,
              },
            ],
          },
        ],
        faultDeclarations: { declarations: [], negativeTests: [] },
        validationProfile: "strict",
        integrations: [],
      });

      if (prepared.status !== "awaiting-approval") {
        throw new Error(
          `prepare failed: ${prepared.code}; operations=${fixture.operations.join(",")}`,
        );
      }
      expect(prepared.review.preview.targets).toEqual([
        expect.objectContaining({
          path: targetPath,
          candidateDigest: digest(candidate),
        }),
      ]);
      expect(fixture.operations).toEqual([
        "source-describe",
        "source-start",
        "source-advance",
        "source-advance",
        "source-advance",
        "phase2-prepare",
      ]);
      expect(fixture.destination.currentText(targetPath)).toBeUndefined();
      const promoted = await fixture.workflow.approveAndPromote({
        review: prepared.review,
        token: "approve",
      });
      if (promoted.status !== "completed") {
        throw new Error(`promotion failed: ${promoted.code}`);
      }
      expect(promoted.status).toBe("completed");
      expect(fixture.destination.currentText(targetPath)).toBe(candidate);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a method-copy fake of an authentic source engine", async () => {
    const fixture = await createFixture();
    try {
      const sourceEngineering = Object.freeze({
        describe: fixture.config.sourceEngineering.describe,
        start: fixture.config.sourceEngineering.start,
        advance: fixture.config.sourceEngineering.advance,
        verify: fixture.config.sourceEngineering.verify,
      });

      expect(
        createEngineeringWorkflow(
          Object.freeze({ ...fixture.config, sourceEngineering }),
        ),
      ).toEqual({ status: "rejected", code: "INVALID_WORKFLOW_CONFIG" });
    } finally {
      fixture.cleanup();
    }
  });
});
