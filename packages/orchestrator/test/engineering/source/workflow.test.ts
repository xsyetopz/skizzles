import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { isChangeAssuranceReceipt } from "@skizzles/change-assurance";
import { snapshotRecord } from "../../../src/engineering/snapshot.ts";
import { createEngineeringWorkflow } from "../../../src/engineering/workflow.ts";
import { createTestChangeDeclaration } from "../assurance-fixture.ts";
import {
  candidate,
  createFixture,
  digest,
  replacement,
  targetPath,
} from "./fixture.ts";

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
      expect(described.context.templates[0]?.language).toBe("typescript");
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
        changeDeclaration: createTestChangeDeclaration({
          requestDigest: fixture.repository.request.intentDigest,
          repositoryId: fixture.repository.repository.repositoryId,
          targets: Object.freeze([
            Object.freeze({
              path: targetPath,
              candidateDigest: digest(candidate),
            }),
          ]),
        }),
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
          `prepare failed: ${prepared.code}; operations=${fixture.operations.join(
            ",",
          )}`,
        );
      }
      expect(prepared.review.preview.targets).toEqual([
        expect.objectContaining({
          path: targetPath,
          candidateDigest: digest(candidate),
        }),
      ]);
      expect(isChangeAssuranceReceipt(prepared.review.preview.assurance)).toBe(
        true,
      );
      const diff = snapshotRecord(
        JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(prepared.review.approval.diffBytes),
          ),
        ),
        ["version", "taskWorktree", "engineeringEvidence", "targets"],
      );
      const engineeringEvidence = snapshotRecord(
        diff?.["engineeringEvidence"],
        ["evidenceDigest", "evidenceBase64"],
      );
      const evidenceBase64 = engineeringEvidence?.["evidenceBase64"];
      expect(typeof evidenceBase64).toBe("string");
      if (typeof evidenceBase64 !== "string") {
        throw new Error("engineering evidence missing from approval diff");
      }
      const evidence = snapshotRecord(
        JSON.parse(Buffer.from(evidenceBase64, "base64").toString("utf8")),
        [
          "version",
          "stage",
          "contextReceiptDigest",
          "baselineDigest",
          "preview",
          "sourceReceipt",
          "validationProfile",
        ],
      );
      const evidencePreview = snapshotRecord(evidence?.["preview"], [
        "evidenceDigest",
        "candidateDigest",
        "provenanceDigest",
        "validationDigest",
        "observedNegativeTests",
        "targets",
        "integrations",
        "assurance",
        "security",
        "taskVerificationReceipts",
        "verificationGateReceipt",
      ]);
      const assuranceReceipt = snapshotRecord(evidencePreview?.["assurance"], [
        "requestDigest",
        "repositoryId",
        "treeDigest",
        "baselineDigest",
        "targetSetDigest",
        "candidateDigest",
        "candidateManifestDigest",
        "declarationDigest",
        "extensionReceipts",
        "receiptDigest",
      ]);
      expect(assuranceReceipt?.["receiptDigest"]).toBe(
        prepared.review.preview.assurance.receiptDigest,
      );
      expect(fixture.operations).toEqual([
        "source-describe",
        "source-start",
        "source-advance",
        "source-advance",
        "source-advance",
        "change-assurance",
        "security-review",
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
      const changeAssurance = Object.freeze({
        assess: fixture.config.changeAssurance.assess,
        verify: fixture.config.changeAssurance.verify,
      });
      expect(
        createEngineeringWorkflow(
          Object.freeze({ ...fixture.config, changeAssurance }),
        ),
      ).toEqual({ status: "rejected", code: "INVALID_WORKFLOW_CONFIG" });
    } finally {
      fixture.cleanup();
    }
  });
});
