import { describe, expect, it } from "bun:test";
import { parseTypeScriptSource } from "../src/typescript/parser.ts";
import { analyzeModifiedExecutables } from "../src/typescript/structural.ts";

const path = "src/complexity.ts";
const baseline =
  "export function choose(value: number): number { if (value > 0) return value; return 0; }\n";
const candidate = `export function choose(value?: number): number {
  const nested = (item: number): number => item > 0 && item < 10 ? item : 0;
  if ((value ?? 0) > 1 || value === 0) return nested(value ?? 0);
  return 0;
}
`;

describe("cyclomatic-v1 structural evidence", () => {
  it("maps branch operators and nested functions to versioned executable evidence", async () => {
    const result = await analyze(baseline, candidate, policy());
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("analysis rejected");
    expect(result.modifiedNodes.map(({ kind }) => kind).sort()).toEqual([
      "arrow-function",
      "function",
    ]);
    const parent = result.modifiedNodes.find(({ kind }) => kind === "function");
    const nested = result.modifiedNodes.find(
      ({ kind }) => kind === "arrow-function",
    );
    expect(parent?.candidate?.branchIds).toHaveLength(4);
    expect(nested?.candidate?.branchIds).toHaveLength(2);
    expect(
      parent?.mutationSites.some(
        ({ kind, operator }) =>
          kind === "condition" && operator === "QuestionQuestionToken",
      ),
    ).toBe(true);
    expect(nested?.mutationSites.some(({ kind }) => kind === "boundary")).toBe(
      true,
    );
    expect(
      result.modifiedNodes.every(
        ({ complexityReceiptDigest, baseline, candidate: current }) =>
          complexityReceiptDigest.startsWith("sha256:") &&
          (baseline?.versionDigest.startsWith("sha256:") ?? true) &&
          (current?.versionDigest.startsWith("sha256:") ?? true),
      ),
    ).toBe(true);
    expect(
      result.modifiedNodes.every(({ mutationSites }) =>
        mutationSites.every(
          ({ variants }) =>
            variants.length > 0 &&
            variants.length ===
              new Set(variants.map(({ variantId }) => variantId)).size,
        ),
      ),
    ).toBe(true);
    expect(
      result.modifiedNodes.every(
        ({ lineIds }) =>
          lineIds.length > 0 && lineIds.length === new Set(lineIds).size,
      ),
    ).toBe(true);
    const repeated = await analyze(baseline, candidate, policy());
    expect(repeated).toEqual(result);
  });

  it("enforces per-function, increase, and aggregate limits", async () => {
    for (const structuralPolicy of [
      policy({ maxFunctionComplexity: 2 }),
      policy({ maxFunctionIncrease: 1 }),
      policy({ maxAggregateIncrease: 0 }),
    ]) {
      expect(
        (await analyze(baseline, candidate, structuralPolicy)).status,
      ).toBe("rejected");
    }
  });

  it("rejects ambiguous nested-function maps instead of accepting split evasion", async () => {
    const ambiguous = `export function choose(value: number): number {
  function inner(item: number): number { return item > 0 ? item : 0; }
  function inner(item: number): number { return item < 0 ? item : 0; }
  return inner(value);
}
`;
    expect((await analyze(baseline, ambiguous, policy())).status).toBe(
      "rejected",
    );
  });

  it("maps class-field initializers and rejects their hidden branch complexity", async () => {
    const before = `export class Choice {}
export function marker(): number { return 0; }
`;
    const after = `export class Choice {
  value = true ? (false ? 1 : 2) : (true ? 3 : 4);
}
export function marker(): number { return 1; }
`;
    expect(
      (
        await analyze(
          before,
          after,
          policy({ maxFunctionComplexity: 1, maxFunctionIncrease: 0 }),
        )
      ).status,
    ).toBe("rejected");
    const accepted = await analyze(before, after, policy());
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("analysis rejected");
    const initializer = accepted.modifiedNodes.find(
      ({ kind }) => kind === "class-initializer",
    );
    expect(initializer?.functionKey).toBe("class:Choice/initializer");
    expect(initializer?.candidateComplexity).toBe(4);
    expect(initializer?.candidate?.branchIds).toHaveLength(3);
  });

  it("does not report class initialization for an ordinary method-body edit", async () => {
    const before = `export class C {
  value = true ? 1 : 0;
  method(): number { return 1; }
}
`;
    const after = `export class C {
  value = true ? 1 : 0;
  method(): number { return 2; }
}
`;
    const result = await analyze(before, after, policy());
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("analysis rejected");
    expect(
      result.modifiedNodes.map(({ functionKey, kind }) => ({
        functionKey,
        kind,
      })),
    ).toEqual([{ functionKey: "class:C/method:method", kind: "method" }]);
    expect(result.modifiedNodes[0]?.lineIds.length).toBeGreaterThan(0);
  });

  it("prunes nested function bodies from parent and module projections", async () => {
    const before = `export const choose = (): number => 1;
export function outer(): number {
  const inner = (): number => 1;
  return inner();
}
`;
    const after = `export const choose = (flag: boolean): number => flag ? 1 : 0;
export function outer(): number {
  const inner = (flag: boolean): number => flag ? 1 : 0;
  return inner();
}
`;
    const result = await analyze(before, after, policy());
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("analysis rejected");
    expect(result.modifiedNodes.map(({ kind }) => kind)).toEqual([
      "arrow-function",
      "arrow-function",
    ]);
    expect(
      result.modifiedNodes.every(
        ({ candidate: current }) => current?.branchIds.length === 1,
      ),
    ).toBe(true);
  });

  it("maps static blocks with complete deterministic mutation variants", async () => {
    const before = "export class Cache { static value = 0; }\n";
    const after = `export class Cache {
  static value = 0;
  static {
    const selected = true ? (false ? 1 : 2) : 3;
    if (selected > 0) this.value = selected;
  }
}
`;
    expect(
      (
        await analyze(
          before,
          after,
          policy({ maxFunctionComplexity: 1, maxFunctionIncrease: 0 }),
        )
      ).status,
    ).toBe("rejected");
    const first = await analyze(before, after, policy());
    const repeated = await analyze(before, after, policy());
    expect(first).toEqual(repeated);
    expect(first.status).toBe("accepted");
    if (first.status !== "accepted") throw new Error("analysis rejected");
    const initializer = first.modifiedNodes.find(
      ({ kind }) => kind === "class-initializer",
    );
    expect(initializer?.candidate?.branchIds).toHaveLength(3);
    expect(
      initializer?.candidate?.mutationSites.every(
        ({ variants }) =>
          variants.length > 0 &&
          variants.length ===
            new Set(variants.map(({ variantId }) => variantId)).size,
      ),
    ).toBe(true);
  });

  it("maps top-level executable expressions as a module initializer", async () => {
    const before = "export const selected = 0;\n";
    const after =
      "export const selected = true ? (false ? 1 : 2) : (true ? 3 : 4);\n";
    expect(
      (
        await analyze(
          before,
          after,
          policy({ maxFunctionComplexity: 1, maxFunctionIncrease: 0 }),
        )
      ).status,
    ).toBe("rejected");
    const accepted = await analyze(before, after, policy());
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("analysis rejected");
    expect(accepted.modifiedNodes).toHaveLength(1);
    expect(accepted.modifiedNodes[0]?.kind).toBe("module-initializer");
    expect(accepted.modifiedNodes[0]?.functionKey).toBe("module-initializer");
    expect(accepted.modifiedNodes[0]?.candidateComplexity).toBe(4);
  });
});

async function analyze(
  baselineText: string,
  candidateText: string,
  structuralPolicy: ReturnType<typeof policy>,
) {
  const before = await parseTypeScriptSource({
    targetPath: path,
    sourceText: baselineText,
  });
  const after = await parseTypeScriptSource({
    targetPath: path,
    sourceText: candidateText,
  });
  if (before.status !== "parsed" || after.status !== "parsed") {
    throw new Error("structural fixture parse failed");
  }
  return analyzeModifiedExecutables({
    baseline: Object.freeze([
      Object.freeze({ path, sourceFile: before.parsed.sourceFile }),
    ]),
    candidate: Object.freeze([
      Object.freeze({ path, sourceFile: after.parsed.sourceFile }),
    ]),
    policy: structuralPolicy,
  });
}

function policy(
  overrides: Partial<{
    maxFunctionComplexity: number;
    maxFunctionIncrease: number;
    maxAggregateIncrease: number;
  }> = {},
) {
  return Object.freeze({
    metricVersion: "cyclomatic-v1" as const,
    maxFunctionComplexity: 64,
    maxFunctionIncrease: 64,
    maxAggregateIncrease: 128,
    ...overrides,
  });
}
