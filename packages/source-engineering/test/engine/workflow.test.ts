// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { afterEach, describe, expect, it } from "bun:test";
import { createSourceEngineering } from "../../src/index.ts";
import {
  batchRequest,
  cleanupCompilerRoots,
  createEvidence,
  declaration,
  describeRequest,
  digest,
  engineConfig,
  productionCandidate,
  productionPath,
  registerFormatter,
  schemaText,
  testCandidate,
  testPath,
  textOf,
} from "./workflow-fixture.ts";

afterEach(() => {
  cleanupCompilerRoots();
});

describe("public source-engineering workflow", () => {
  it("describes, edits, formats, validates, and verifies exact artifacts once", async () => {
    const captureOrder: string[] = [];
    const sourceEvidence = createEvidence(captureOrder);
    const formatter = registerFormatter();
    const created = createSourceEngineering(
      engineConfig(sourceEvidence, formatter),
    );
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      throw new Error(`engine setup failed: ${created.code}`);
    }
    const engine = created.sourceEngineering;

    const described = await engine.describe(describeRequest());
    expect(described.status).toBe("described");
    if (described.status !== "described") {
      throw new Error(`describe failed: ${described.code}`);
    }
    expect(captureOrder).toEqual([productionPath, testPath]);
    expect(described.context.templates).toEqual([
      {
        templateId: "typescript-function",
        language: "typescript",
        schemaText,
        schemaDigest: digest(schemaText),
        tool: "template-tool",
        version: "1.0.0",
      },
    ]);
    expect(
      described.context.targets.map(({ path, declarations }) => ({
        path,
        declarations: declarations.map(({ declarationKind, name }) => ({
          declarationKind,
          name,
        })),
      })),
    ).toEqual([
      {
        path: productionPath,
        declarations: [{ declarationKind: "function", name: "value" }],
      },
      {
        path: testPath,
        declarations: [{ declarationKind: "function", name: "valueFailure" }],
      },
    ]);

    const productionDeclaration = declaration(
      described.context,
      productionPath,
      "value",
    );
    const testDeclaration = declaration(
      described.context,
      testPath,
      "valueFailure",
    );
    const batch = batchRequest(
      described.receipt,
      described.context.contextDigest,
      productionDeclaration.nodeDigest,
      testDeclaration.nodeDigest,
    );
    const started = engine.start(batch);
    expect(started.status).toBe("ready");
    if (started.status !== "ready") {
      throw new Error(`start failed: ${started.code}`);
    }
    expect(started.next).toEqual({
      kind: "edit",
      ordinal: 0,
      operationIndex: 0,
    });

    const firstCursor = started.cursor;
    const editedProduction = await engine.advance(
      Object.freeze({ cursor: firstCursor }),
    );
    expect(editedProduction.status).toBe("ready");
    if (editedProduction.status !== "ready") {
      throw new Error("production edit did not advance");
    }
    expect(editedProduction.next).toEqual({ kind: "format", ordinal: 1 });
    expect(
      await engine.advance(Object.freeze({ cursor: firstCursor })),
    ).toEqual({ status: "rejected", code: "CURSOR_REPLAYED" });

    const formattedProduction = await engine.advance(
      Object.freeze({ cursor: editedProduction.cursor }),
    );
    expect(formattedProduction.status).toBe("ready");
    if (formattedProduction.status !== "ready") {
      throw new Error("production format did not advance");
    }
    expect(formattedProduction.next).toEqual({
      kind: "edit",
      ordinal: 2,
      operationIndex: 0,
    });

    const editedTest = await engine.advance(
      Object.freeze({ cursor: formattedProduction.cursor }),
    );
    expect(editedTest.status).toBe("ready");
    if (editedTest.status !== "ready") {
      throw new Error("negative-path edit did not advance");
    }
    expect(editedTest.next).toEqual({ kind: "format", ordinal: 3 });

    const formattedTest = await engine.advance(
      Object.freeze({ cursor: editedTest.cursor }),
    );
    expect(formattedTest.status).toBe("ready");
    if (formattedTest.status !== "ready") {
      throw new Error("negative-path format did not advance");
    }
    expect(formattedTest.next).toEqual({ kind: "validate", ordinal: 4 });

    const prepared = await engine.advance(
      Object.freeze({ cursor: formattedTest.cursor }),
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error(
        prepared.status === "rejected"
          ? `validation failed: ${prepared.code}`
          : "validation returned another cursor",
      );
    }
    expect(prepared.artifacts.map(({ path }) => path)).toEqual([
      productionPath,
      testPath,
    ]);
    expect(textOf(prepared.artifacts[0]?.readBytes())).toBe(
      productionCandidate,
    );
    expect(textOf(prepared.artifacts[1]?.readBytes())).toBe(testCandidate);
    expect(prepared.receipt.compilerReceipt.receipts).toHaveLength(2);
    expect(prepared.receipt.policyReceipt.findingCount).toBe(0);
    expect(prepared.receipt.indexReceipt).toMatchObject({ status: "indexed" });

    const verificationInput = Object.freeze({
      artifacts: prepared.artifacts,
      receipt: prepared.receipt,
    });
    expect(engine.verify(verificationInput)).toEqual({
      status: "valid",
      candidateDigest: prepared.receipt.candidateDigest,
      provenanceDigest: prepared.receipt.provenanceDigest,
      validationDigest: prepared.receipt.validationDigest,
    });
    expect(engine.verify(verificationInput)).toEqual({
      status: "rejected",
      code: "RECEIPT_REPLAYED",
    });
    expect(engine.start(batch)).toEqual({
      status: "rejected",
      code: "CONTEXT_REPLAYED",
    });
  });
});
