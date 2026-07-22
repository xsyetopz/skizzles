// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: TypeScript 7's parser is an unstable package export.
import { API } from "typescript/unstable/async";
import {
  analyzeSourcePolicy,
  createLiteralRegistry,
  type LiteralRegistrySnapshot,
  type ParsedPolicyChange,
  type PolicyAnalysisInput,
  type PolicyFinding,
  type PolicyFindingCode,
} from "../../src/policy/index.ts";

interface SourceCase {
  readonly path: string;
  readonly ownership: "production" | "test";
  readonly baseline?: string;
  readonly candidate: string;
}

interface ParsedDocument {
  readonly sourceCase: SourceCase;
  readonly candidatePath: string;
  readonly baselinePath?: string;
}

describe("parsed changed-node source policies", () => {
  it("rejects structured identity assertions, empty catches, and unused-binding evasions", async () => {
    const findings = await analyzeCases([
      {
        path: "test/policy.test.ts",
        ownership: "test",
        candidate: [
          // biome-ignore lint/security/noSecrets: source text is a JSON assertion fixture, not a credential.
          'expect(JSON.stringify(payload)).toBe("{\\"ok\\":true}");',
          "expect({ ok: true }).toBe({ ok: true });",
          "try { run(); } catch (error) {}",
          "try { run(); } catch (error) { void error; }",
        ].join("\n"),
      },
    ]);

    expect(codes(findings)).toEqual([
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "UNUSED_CATCH_BINDING",
      "EMPTY_CATCH",
      "UNUSED_CATCH_BINDING",
    ]);
  });

  it("allows scalar diagnostics, structural matchers, and deliberate catch handling", async () => {
    const findings = await analyzeCases([
      {
        path: "test/policy.test.ts",
        ownership: "test",
        candidate: [
          'expect(status).toBe("ready");',
          'expect(diagnostic).toBe("exact failure");',
          "expect(actual).toEqual({ ok: true });",
          "try { run(); } catch (error) { report(error); throw error; }",
        ].join("\n"),
      },
    ]);

    expect(codes(findings)).toEqual([]);
  });

  it("does not report unchanged pre-existing debt", async () => {
    const existing = "try { run(); } catch (error) {}";
    const findings = await analyzeCases([
      {
        path: "test/policy.test.ts",
        ownership: "test",
        baseline: existing,
        candidate: `${existing}\nexpect(status).toBe("ready");`,
      },
    ]);

    expect(codes(findings)).toEqual([]);
  });

  it("rejects placeholder and unsafe-boundary evasion patterns", async () => {
    const findings = await analyzeCases([
      {
        path: "test/policy.test.ts",
        ownership: "test",
        candidate: [
          "// T O D O is prose and not a placeholder marker",
          "// TODO: wire this later",
          'function pending() { throw new Error("not_implemented"); }',
          "function empty() {}",
          "const payload: any = JSON.parse(text) as Payload;",
          // biome-ignore lint/security/noSecrets: source text exercises non-null assertion syntax.
          "consume(payload!.id);",
        ].join("\n"),
      },
    ]);

    expect(new Set(codes(findings))).toEqual(
      new Set<PolicyFindingCode>([
        "PLACEHOLDER_COMMENT",
        "STUB_THROW",
        "EMPTY_NAMED_BODY",
        "EXPLICIT_ANY",
        "UNSCHEMATIZED_DYNAMIC_BOUNDARY",
        "UNSAFE_TYPE_ASSERTION",
        "UNSAFE_NON_NULL_ASSERTION",
      ]),
    );
  });

  it("allows unknown-first and schema-validated dynamic data", async () => {
    const findings = await analyzeCases([
      {
        path: "test/policy.test.ts",
        ownership: "test",
        candidate: [
          "const raw: unknown = JSON.parse(text);",
          "const parsed = PayloadSchema.parse(JSON.parse(text));",
          "const frozen = { retries: 3 } as const;",
          "const checked = input satisfies Payload;",
          "void raw; void parsed; void frozen; void checked;",
        ].join("\n"),
      },
    ]);

    expect(codes(findings)).toEqual([]);
  });

  it("requires fault declarations and changed negative-path evidence", async () => {
    const missing = await analyzeCases([
      {
        path: "src/service.ts",
        ownership: "production",
        candidate: "export function serve() { return true; }",
      },
    ]);
    expect(codes(missing)).toEqual(["FAULT_FIRST_DECLARATION_MISSING"]);

    const admitted = await analyzeCases(
      [
        {
          path: "src/service.ts",
          ownership: "production",
          candidate: "export function serve() { return true; }",
        },
        {
          path: "test/service.test.ts",
          ownership: "test",
          baseline: "export {};",
          candidate: 'expect(result.code).toBe("SERVICE_DOWN");',
        },
      ],
      {
        declarations: [
          { productionPath: "src/service.ts", failureCodes: ["SERVICE_DOWN"] },
        ],
        negativeTests: [
          {
            productionPath: "src/service.ts",
            testPath: "test/service.test.ts",
          },
        ],
      },
    );
    expect(codes(admitted)).toEqual([]);
  });

  it("fails closed for hostile runtime input and returns frozen findings", () => {
    const findings = analyzeSourcePolicy({ changes: null });

    expect(findings).toEqual([
      {
        path: "<policy-input>",
        start: 0,
        end: 0,
        code: "INVALID_POLICY_INPUT",
        message: "Policy analysis input did not match the closed contract.",
      },
    ]);
    expect(Object.isFrozen(findings)).toBe(true);
    expect(Object.isFrozen(findings[0])).toBe(true);
  });
});

async function analyzeCases(
  cases: readonly SourceCase[],
  faultFirst: PolicyAnalysisInput["faultFirst"] = {
    declarations: [],
    negativeTests: [],
  },
  literalRegistry: LiteralRegistrySnapshot = registeredSnapshot([]),
): Promise<readonly PolicyFinding[]> {
  const root = mkdtempSync(join(tmpdir(), "skizzles-source-policy-"));
  const api = new API();
  try {
    const documents: ParsedDocument[] = cases.map((sourceCase, index) => {
      const candidatePath = join(root, `${index}-candidate.ts`);
      writeFileSync(candidatePath, sourceCase.candidate);
      if (sourceCase.baseline === undefined) {
        return { sourceCase, candidatePath };
      }
      const baselinePath = join(root, `${index}-baseline.ts`);
      writeFileSync(baselinePath, sourceCase.baseline);
      return { sourceCase, candidatePath, baselinePath };
    });
    const openFiles = documents.flatMap(({ candidatePath, baselinePath }) =>
      baselinePath === undefined
        ? [candidatePath]
        : [candidatePath, baselinePath],
    );
    const snapshot = await api.updateSnapshot({ openFiles });
    try {
      const changes = await Promise.all(
        documents.map(async ({ sourceCase, candidatePath, baselinePath }) => {
          const candidate = await sourceFile(snapshot, candidatePath);
          const baseline =
            baselinePath === undefined
              ? null
              : await sourceFile(snapshot, baselinePath);
          return {
            path: sourceCase.path,
            ownership: sourceCase.ownership,
            baselineText: sourceCase.baseline ?? null,
            baseline,
            candidateText: sourceCase.candidate,
            candidate,
          };
        }),
      );
      return analyzeSourcePolicy({ changes, faultFirst, literalRegistry });
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
    rmSync(root, { force: true, recursive: true });
  }
}

function registeredSnapshot(
  entries: readonly Readonly<{
    key: string;
    value: string | number;
    description: string;
  }>[],
): LiteralRegistrySnapshot {
  const created = createLiteralRegistry(
    Object.freeze({
      registryId: "source-parameters",
      registryPath: "src/config/parameters.ts",
      exportName: "SOURCE_PARAMETERS",
    }),
  );
  if (created.status !== "created") throw new Error(created.code);
  let snapshot = created.registry.snapshot();
  for (const entry of entries) {
    const registered = created.registry.register(Object.freeze(entry));
    if (registered.status !== "registered") throw new Error(registered.code);
    snapshot = registered.snapshot;
  }
  return snapshot;
}

async function sourceFile(
  snapshot: Awaited<ReturnType<API["updateSnapshot"]>>,
  path: string,
): Promise<ParsedPolicyChange["candidate"]> {
  const project = await snapshot.getDefaultProjectForFile(path);
  const source = await project?.program.getSourceFile(path);
  if (source === undefined) {
    throw new Error(`TypeScript did not parse ${path}`);
  }
  return source;
}

function codes(findings: readonly PolicyFinding[]): PolicyFindingCode[] {
  return findings.map(({ code }) => code);
}
