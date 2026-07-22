// biome-ignore-all lint/security/noSecrets: Embedded candidate programs intentionally exercise assertion-policy syntax, not credentials.
import { describe, expect, it } from "bun:test";
import {
  analyzeSourcePolicy,
  createLiteralRegistry,
  type LiteralRegistrySnapshot,
  type ParsedPolicyChange,
  type PolicyFinding,
  type PolicyFindingCode,
} from "../../src/policy/index.ts";
import { parseTypeScriptSource } from "../../src/typescript/parser.ts";

describe("semantic assertion policy", () => {
  it("rejects serialized complex values across common assertion forms", async () => {
    const findings = await analyzeCandidate(
      [
        "expect(payload).toBe('{\"ok\":true}');",
        "assert.strictEqual(serialized, '[1,2]');",
        "expect(JSON.stringify(payload)).toEqual(snapshot);",
        "expect(payload === '[1,2]').toBe(true);",
        "assert(payload === '[1,2]');",
        "expect(payload).to.equal('[1,2]');",
        "assertEquals(payload, '[1,2]');",
        "expect(payload).not.toBe('[1,2]');",
        "assert.notStrictEqual(payload, '[1,2]');",
        "assertNotEquals(payload, '[1,2]');",
      ].join("\n"),
    );

    expect(codes(findings)).toEqual([
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
    ]);
  });

  it("rejects string assertions against explicit complex expressions", async () => {
    const findings = await analyzeCandidate(
      [
        'expect({ ok: true }).toBe("ready");',
        'assert.strictEqual([1, 2], "ready");',

        'expect(JSON.parse(text)).toEqual("ready");',
        'expect(new Map()).toBe("ready");',
        "assert.strictEqual({ ok: true }, { ok: true });",
      ].join("\n"),
    );

    expect(codes(findings)).toEqual([
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "UNSCHEMATIZED_DYNAMIC_BOUNDARY",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
    ]);
  });
});

describe("semantic assertion policy scalar boundaries", () => {
  it("preserves legitimate scalar string assertions", async () => {
    const findings = await analyzeCandidate(
      [
        'expect(status).toBe("ready");',
        'expect(diagnostic).toEqual("exact failure");',
        'assert.strictEqual(code, "SERVICE_DOWN");',
        'expect(version).toMatch("v1");',

        'expect(JSON.stringify("ready")).toBe(\'"ready"\');',
        'expect(payloadText).toBe("[not serialized JSON]");',
        "expect(actual).toStrictEqual({ ok: true });",
        'const isReady = status === "ready";',
        "void isReady;",
      ].join("\n"),
    );

    expect(codes(findings)).toEqual([]);
  });

  it("rejects serialized values folded from concatenations and templates", async () => {
    const findings = await analyzeCandidate(
      [
        `expect(payload).toBe('{"ok":' + 'true}');`,
        `assert.strictEqual(payload, ("[" + "1]"));`,
        'expect(payload).toEqual(`{"ok":${true}}`);',
        "assert(payload === `[` + 1 + `]`);",

        "expect(payload).toStrictEqual(`{\"ok\":${'true'}}`);",
      ].join("\n"),
    );

    expect(codes(findings)).toEqual([
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
    ]);
  });

  it("rejects immutable const compositions and ambiguous container envelopes", async () => {
    const findings = await analyzeCandidate(
      [
        `const open = '{"ok":' as const;`,
        `const serialized = open + 'true}';`,
        "const list = `[` satisfies string;",
        "const listValue = list + value + `]`;",
        "expect(payload).toBe(serialized);",
        "assert.deepEqual(payload, listValue);",
        'expect(payload).toEqual(`{"state":${status}}`);',
      ].join("\n"),
    );

    expect(codes(findings)).toEqual([
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
      "BRITTLE_STRUCTURE_ASSERTION",
    ]);
  });

  it("preserves scalar diagnostic compositions and unknown non-container values", async () => {
    const findings = await analyzeCandidate(
      [
        "expect(status).toBe('status:' + statusCode);",

        "expect(diagnostic).toEqual(`error: \${detail}`);",
        "assert.strictEqual(message, prefix + detail);",
        "expect(status).toBe(statusPrefix + statusCode);",
      ].join("\n"),
    );

    expect(codes(findings)).toEqual([]);
  });

  it("keeps unchanged composed assertions outside the changed-node scope", async () => {
    const existing = [
      `const prefix = '{"ok":';`,
      `expect(payload).toBe(prefix + 'true}');`,
    ].join("\n");
    const findings = await analyzeCandidate(
      `${existing}\nexpect(status).toBe("ready");`,
      existing,
    );

    expect(codes(findings)).toEqual([]);
  });

  it("does not relint an unchanged pre-existing brittle assertion", async () => {
    const existing = "expect(payload).toBe('[1,2]');";
    const findings = await analyzeCandidate(
      `${existing}\nexpect(status).toBe("ready");`,
      existing,
    );

    expect(codes(findings)).toEqual([]);
  });
});

async function analyzeCandidate(
  candidateText: string,
  baselineText: string | null = null,
): Promise<readonly PolicyFinding[]> {
  const candidate = await parsed("test/assertions.test.ts", candidateText);
  let baseline: ParsedPolicyChange["baseline"] = null;
  if (baselineText !== null) {
    baseline = await parsed("test/assertions.test.ts", baselineText);
  }
  return analyzeSourcePolicy({
    changes: [
      {
        path: "test/assertions.test.ts",
        ownership: "test",
        baselineText,
        baseline,
        candidateText,
        candidate,
      },
    ],
    faultFirst: { declarations: [], negativeTests: [] },
    literalRegistry: emptyLiteralRegistry(),
  });
}

async function parsed(
  targetPath: string,
  sourceText: string,
): Promise<ParsedPolicyChange["candidate"]> {
  const result = await parseTypeScriptSource({ targetPath, sourceText });
  if (result.status !== "parsed") {
    throw new Error(`fixture failed to parse: ${result.code}`);
  }
  return result.parsed.sourceFile;
}

function codes(
  findings: readonly { code: PolicyFindingCode }[],
): PolicyFindingCode[] {
  return findings.map(({ code }) => code);
}

function emptyLiteralRegistry(): LiteralRegistrySnapshot {
  const created = createLiteralRegistry(
    Object.freeze({
      registryId: "assertion-policy",
      registryPath: "src/config/assertion-policy.ts",
      exportName: "ASSERTION_POLICY",
    }),
  );
  if (created.status !== "created") {
    throw new Error(created.code);
  }
  return created.registry.snapshot();
}
