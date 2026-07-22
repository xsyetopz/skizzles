// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import type { SourceEngineering } from "@skizzles/source-engineering";
import { digestBytes } from "../../../src/digest.ts";
import {
  advanceSourceEngineering,
  readSourceArtifact,
} from "../../../src/engineering/source/adapter.ts";

const bytes = new TextEncoder().encode("export const ready = true;\n");
const digest = digestBytes(bytes);

describe("source-engineering adapter", () => {
  it("rejects caller-authored structural evidence and reads copied artifact bytes", async () => {
    const artifact = Object.freeze({
      path: "src/example.ts",
      baselineDigest: digest,
      baselineByteLength: bytes.byteLength,
      digest,
      byteLength: bytes.byteLength,
      readBaselineBytes: (): Uint8Array => Uint8Array.from(bytes),
      readBytes: (): Uint8Array => Uint8Array.from(bytes),
    });
    const receipt = Object.freeze({
      requestDigest: digest,
      contextDigest: digest,
      contextReceiptDigest: digest,
      baselineDigest: digest,
      candidateDigest: digest,
      candidateManifestDigest: digest,
      targetReceipts: Object.freeze([
        Object.freeze({
          path: "src/example.ts",
          baselineDigest: digest,
          candidateDigest: digest,
          baselineSemanticDigest: digest,
          candidateSemanticDigest: digest,
          changedDeclarations: Object.freeze([]),
          templateReceipts: Object.freeze([]),
          formatterReceipt: Object.freeze({
            path: "src/example.ts",
            profileId: "biome",
            tool: "biome",
            version: "2.5.4",
            treeDigest: digest,
            configDigest: digest,
            candidateDigest: digest,
            candidateSemanticDigest: digest,
            pass1Digest: digest,
            pass2Digest: digest,
            formattedDigest: digest,
            formattedSemanticDigest: digest,
            provenanceDigest: digest,
            formattedBytes: Object.freeze(Array.from(bytes)),
          }),
        }),
      ]),
      indexReceipt: Object.freeze({
        status: "indexed",
        language: "typescript",
        advisory: true,
        indexDigest: digest,
      }),
      compilerReceipt: Object.freeze({
        receipts: Object.freeze([]),
        receiptDigest: digest,
      }),
      structuralReceipt: Object.freeze({
        requestDigest: digest,
        repositoryId: "repo-a",
        rootIdentity: "root-a",
        treeDigest: digest,
        configDigest: digest,
        targetSetDigest: digest,
        baselineCandidateSetDigest: digest,
        candidateSetDigest: digest,
        policy: Object.freeze({
          metricVersion: "cyclomatic-v1" as const,
          maxFunctionComplexity: 64,
          maxFunctionIncrease: 64,
          maxAggregateIncrease: 64,
          policyDigest: digest,
        }),
        astChanges: Object.freeze([]),
        modifiedNodes: Object.freeze([]),
        baselineAggregateComplexity: 0,
        candidateAggregateComplexity: 0,
        aggregateIncrease: 0,
        compilerChain: Object.freeze({
          targetSetDigest: digest,
          baselineCandidateSetDigest: digest,
          finalCandidateSetDigest: digest,
          links: Object.freeze([]),
          receiptDigest: digest,
        }),
        receiptDigest: digest,
      }),
      policyReceipt: Object.freeze({
        findingCount: 0,
        changeSetDigest: digest,
        literalRegistryDigest: digest,
        observedNegativeTests: Object.freeze([
          Object.freeze({
            productionPath: "src/example.ts",
            testPath: "test/example.test.ts",
            failureCodes: Object.freeze(["INVALID_INPUT"]),
          }),
        ]),
        faultEvidenceDigest: digest,
        receiptDigest: digest,
      }),
      provenanceDigest: digest,
      validationDigest: digest,
    });
    const engine: SourceEngineering = Object.freeze({
      async describe() {
        return Object.freeze({ status: "rejected", code: "INVALID_INPUT" });
      },
      start() {
        return Object.freeze({
          status: "ready",
          cursor: Object.freeze({
            cursorId: "cursor-a",
            requestDigest: digest,
            stateDigest: digest,
            candidateDigest: digest,
            step: 0,
            totalSteps: 1,
          }),
          next: Object.freeze({ kind: "validate", ordinal: 0 }),
        });
      },
      async advance() {
        return Object.freeze({
          status: "prepared",
          artifacts: Object.freeze([artifact]),
          receipt,
        });
      },
      verify() {
        return Object.freeze({ status: "rejected", code: "RECEIPT_FORGED" });
      },
    });
    const result = await advanceSourceEngineering(
      engine,
      Object.freeze({ cursor: "opaque" }),
    );
    expect(result).toEqual({
      status: "rejected",
      code: "SOURCE_ENGINEERING_REJECTED",
    });
    expect(readSourceArtifact(artifact)).toEqual(Array.from(bytes));
  });
});
