import { describe, expect, it } from "bun:test";
import type {
  NegativePathEvidence,
  ParsedPolicyChange,
  PolicyAnalysisInput,
} from "../../src/policy/contract.ts";
import { inspectFaultFirst } from "../../src/policy/fault-first.ts";
import {
  analyzeSourcePolicy,
  createLiteralRegistry,
} from "../../src/policy/index.ts";
import { parseTypeScriptSource } from "../../src/typescript/parser.ts";

const productionPath = "src/service.ts";
const testPath = "test/service.test.ts";
const productionBaseline = "export function serve(): boolean { return false; }";
const productionCandidate = "export function serve(): boolean { return true; }";

describe("fault-first AST evidence", () => {
  it("derives complete coverage from changed expectations", async () => {
    const input = await policyInput(
      ["BAD_INPUT", "SERVICE_DOWN", "TIMEOUT"],
      "export {};",
      [
        'expect(result.code).toBe("SERVICE_DOWN");',
        "assert.strictEqual(error.code, FailureCode.TIMEOUT);",
        'await expect(run()).rejects.toThrow("BAD_INPUT");',
      ].join("\n"),
    );

    const result = inspectFaultFirst(input);

    expect(result.findings).toEqual([]);
    expect(result.observedEvidence).toEqual([
      {
        productionPath,
        testPath,
        failureCodes: ["BAD_INPUT", "SERVICE_DOWN", "TIMEOUT"],
      },
    ]);
    expect(result.evidenceDigest).toStartWith("sha256:");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observedEvidence)).toBe(true);
  });

  it("accepts a changed exercised error branch", async () => {
    const input = await policyInput(
      ["SERVICE_DOWN"],
      "export {};",
      [
        'if (result.code === "SERVICE_DOWN") {',
        "  exerciseFailure(result);",
        "}",
      ].join("\n"),
    );

    expect(inspectFaultFirst(input).findings).toEqual([]);
  });

  it("rejects caller-claimed codes when the changed test is unrelated", async () => {
    const input = await policyInput(
      ["SERVICE_DOWN"],
      "export {};",
      'it("SERVICE_DOWN", () => expect(result.ok).toBe(true));',
    );
    const forged = Object.freeze({
      changes: input.changes,
      literalRegistry: input.literalRegistry,
      faultFirst: Object.freeze({
        declarations: input.faultFirst.declarations,
        negativeTests: Object.freeze([
          Object.freeze({
            productionPath,
            testPath,
            failureCodes: Object.freeze(["SERVICE_DOWN"]),
          }),
        ]),
      }),
    });

    expect(analyzeSourcePolicy(forged).map(({ code }) => code)).toContain(
      "NEGATIVE_PATH_EVIDENCE_MISSING",
    );
  });

  it("does not reuse an unchanged pre-existing assertion", async () => {
    const existing = 'expect(result.code).toBe("SERVICE_DOWN");';
    const input = await policyInput(
      ["SERVICE_DOWN"],
      existing,
      `${existing}\nexpect(result.ok).toBe(true);`,
    );

    expect(inspectFaultFirst(input).findings.map(({ code }) => code)).toContain(
      "NEGATIVE_PATH_EVIDENCE_MISSING",
    );
    expect(inspectFaultFirst(input).observedEvidence).toEqual([]);
  });

  it("does not credit a formatting-only rewrite of old evidence", async () => {
    const input = await policyInput(
      ["SERVICE_DOWN"],
      'expect(result.code).toBe("SERVICE_DOWN");',
      'expect( result.code ).toBe( "SERVICE_DOWN" );',
    );

    expect(inspectFaultFirst(input).findings.map(({ code }) => code)).toContain(
      "NEGATIVE_PATH_EVIDENCE_MISSING",
    );
    expect(inspectFaultFirst(input).observedEvidence).toEqual([]);
  });

  it("rejects forged path associations and unassociated assertions", async () => {
    const forgedPath = await policyInput(
      ["SERVICE_DOWN"],
      "export {};",
      'expect(result.code).toBe("SERVICE_DOWN");',
      Object.freeze([
        Object.freeze({
          productionPath,
          testPath: "test/other.test.ts",
        }),
      ]),
    );
    expect(
      inspectFaultFirst(forgedPath).findings.map(({ code }) => code),
    ).toContain("NEGATIVE_PATH_EVIDENCE_MISSING");

    const unassociated = await policyInput(
      ["SERVICE_DOWN"],
      "export {};",
      'expect(result.code).toBe("SERVICE_DOWN");',
      Object.freeze([]),
    );
    expect(
      inspectFaultFirst(unassociated).findings.map(({ code }) => code),
    ).toContain("NEGATIVE_PATH_EVIDENCE_MISSING");
  });
});

async function policyInput(
  failureCodes: readonly string[],
  testBaseline: string,
  testCandidate: string,
  negativeTests: readonly NegativePathEvidence[] = Object.freeze([
    Object.freeze({ productionPath, testPath }),
  ]),
): Promise<PolicyAnalysisInput> {
  const registry = createLiteralRegistry(
    Object.freeze({
      registryId: "source-parameters",
      registryPath: "src/config/parameters.ts",
      exportName: "SOURCE_PARAMETERS",
    }),
  );
  if (registry.status !== "created") throw new Error(registry.code);
  return Object.freeze({
    changes: Object.freeze([
      await change(
        productionPath,
        "production",
        productionBaseline,
        productionCandidate,
      ),
      await change(testPath, "test", testBaseline, testCandidate),
    ]),
    literalRegistry: registry.registry.snapshot(),
    faultFirst: Object.freeze({
      declarations: Object.freeze([
        Object.freeze({
          productionPath,
          failureCodes: Object.freeze([...failureCodes]),
        }),
      ]),
      negativeTests,
    }),
  });
}

async function change(
  path: string,
  ownership: ParsedPolicyChange["ownership"],
  baselineText: string,
  candidateText: string,
): Promise<ParsedPolicyChange> {
  return Object.freeze({
    path,
    ownership,
    baselineText,
    baseline: await parsed(path, baselineText),
    candidateText,
    candidate: await parsed(path, candidateText),
  });
}

async function parsed(
  path: string,
  sourceText: string,
): Promise<ParsedPolicyChange["candidate"]> {
  const result = await parseTypeScriptSource({ targetPath: path, sourceText });
  if (result.status !== "parsed") {
    throw new Error(`TypeScript rejected test source: ${result.code}`);
  }
  return result.parsed.sourceFile;
}
