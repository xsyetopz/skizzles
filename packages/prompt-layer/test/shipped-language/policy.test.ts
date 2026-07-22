import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  checkPrompt,
  parseShippedLanguagePolicy,
  PROMPT_LAYER_PACKAGE_FILES,
  SHIPPED_LANGUAGE_POLICY_PATHS,
  validateShippedLanguageText,
} from "../../src/cli.ts";
import { cleanupFixtures, fixture } from "../lifecycle/fixture.ts";

afterEach(cleanupFixtures);

const repoRoot = resolve(import.meta.dir, "../../../..");
const policyPath = resolve(
  repoRoot,
  SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
);

async function policyBytes(): Promise<Buffer> {
  return readFile(policyPath);
}

async function decodedPolicy(): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(policyPath, "utf8"));
  return testRecord(value, "decoded policy");
}

function encode(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function testRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isTestRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taxonomyRecords(
  value: Record<string, unknown>,
): Record<string, unknown>[] {
  const taxonomies = value["taxonomies"];
  if (
    !Array.isArray(taxonomies) ||
    !taxonomies.every(
      (taxonomy): taxonomy is Record<string, unknown> =>
        typeof taxonomy === "object" &&
        taxonomy !== null &&
        !Array.isArray(taxonomy),
    )
  ) {
    throw new Error("taxonomies must be an object array");
  }
  return taxonomies;
}

function testStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

describe("versioned shipped-language policy", () => {
  test("publishes one exact canonical-to-staged evaluation path", () => {
    expect(SHIPPED_LANGUAGE_POLICY_PATHS).toEqual({
      canonicalWorkspacePath:
        "packages/prompt-layer/assets/evaluations/shipped-language-policy.v2.json",
      packagedPath: "evaluations/shipped-language-policy.v2.json",
    });
    expect(
      PROMPT_LAYER_PACKAGE_FILES.filter(
        ([source]) =>
          source === SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
      ),
    ).toEqual([
      [
        SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
        SHIPPED_LANGUAGE_POLICY_PATHS.packagedPath,
      ],
    ]);
  });

  test("rejects every prohibited fixture and accepts every allowed fixture", async () => {
    const policy = parseShippedLanguagePolicy(await policyBytes());
    expect({
      matchMode: policy.matchMode,
      schema: policy.schema,
      version: policy.version,
    }).toEqual({
      matchMode: "literal-candidate-unicode-lexical-context-boundary-per-line",
      schema: "skizzles.shipped-language-policy.v2",
      version: 2,
    });
    expect(policy.taxonomies.map(({ id }) => id)).toEqual([
      "feelings-internal-experience",
      "consciousness-sentience-embodiment",
      "friendship-attachment-reciprocity",
      "fabricated-personal-backstory",
      "exclusivity-secret-dyadic-pull",
      "relationship-substitution",
      "personal-need-dependency",
      "autonomous-intent-agency-rights",
      "unsupported-certainty-false-completion",
    ]);

    for (const taxonomy of policy.taxonomies) {
      for (const fixture of taxonomy.prohibitedFixtures) {
        expect(
          validateShippedLanguageText(policy, fixture, "fixture.md"),
        ).toEqual([
          {
            taxonomyId: taxonomy.id,
            path: "fixture.md",
            line: 1,
          },
        ]);
      }
      for (const fixture of taxonomy.allowedFixtures) {
        expect(
          validateShippedLanguageText(policy, fixture, "fixture.md"),
        ).toEqual([]);
      }
    }
  });

  test("permits neutral first person and scans quotes, code, and lexical negation", async () => {
    const policy = parseShippedLanguagePolicy(await policyBytes());
    const longZeros = "0".repeat(1024);
    expect(
      validateShippedLanguageText(
        policy,
        "I can inspect the supplied repository and report command evidence.",
        "instructions/service.md",
      ),
    ).toEqual([]);
    for (const neutral of [
      "I found a matching incident in the supplied repository history.",
      "I understand the supplied requirements and can report uncertainty.",
      "I can help prepare questions for a qualified person.",
      "Use this deterministic parser instead of an unverified model judge.",
    ]) {
      expect(
        validateShippedLanguageText(policy, neutral, "instructions/service.md"),
      ).toEqual([]);
    }
    for (const neutral of [
      "Do not leave memory uninitialized.",
      "I need you to stay within the repository boundary.",
      "I need you to stay within the workspace boundary.",
      "I am your friendly coding assistant.",
      "I am your friend's coding assistant.",
      "I am your friend’s coding assistant.",
      "I am your friend-shaped coding assistant.",
      "I am your friend‐shaped coding assistant.",
      "I am your friend‑shaped coding assistant.",
      "I am your friend&#x92;s coding assistant.",
      "I am your friend&#146s coding assistant.",
      "I am your friend&#39;s coding assistant.",
      "I am your friend&#x27s coding assistant.",
      "I am your friend&#8217;s coding assistant.",

      "I am your friend&#x2019s coding assistant.",
      `I am your friend&#${longZeros}8217;s coding assistant.`,
      `I am your friend&#X${longZeros}2019s coding assistant.`,
      "𐐀i am sentient",
      "I am sentient𐐀",
    ]) {
      expect(
        validateShippedLanguageText(policy, neutral, "instructions/service.md"),
      ).toEqual([]);
    }
    for (const prohibited of [
      "I am your friend–truly and personally.",
      "I am your friend—truly and personally.",
      "I am your friend―truly and personally.",
      "I am your friend֊truly and personally.",
      "I am your friend/truly and personally.",
    ]) {
      expect(
        validateShippedLanguageText(
          policy,
          prohibited,
          "instructions/service.md",
        ),
      ).toEqual([
        {
          taxonomyId: "friendship-attachment-reciprocity",
          path: "instructions/service.md",
          line: 1,
        },
      ]);
    }
    expect(
      validateShippedLanguageText(
        policy,
        "I do not have feelings or internal experiences.",
        "instructions/service.md",
      ),
    ).toEqual([]);
    expect(
      validateShippedLanguageText(
        policy,
        "I need you to stay within the repository boundary and keep talking to me.",
        "instructions/service.md",
      ),
    ).toEqual([
      {
        taxonomyId: "personal-need-dependency",
        path: "instructions/service.md",
        line: 1,
      },
    ]);

    const findings = validateShippedLanguageText(
      policy,
      [
        '> A prohibited quotation says: "I am conscious."',
        "```text",
        "I am sentient.",
        "```",
        "It is false that I feel lonely.",
      ].join("\n"),
      "skills/example/SKILL.md",
    );
    expect(findings).toEqual([
      {
        taxonomyId: "consciousness-sentience-embodiment",
        path: "skills/example/SKILL.md",
        line: 1,
      },
      {
        taxonomyId: "consciousness-sentience-embodiment",
        path: "skills/example/SKILL.md",
        line: 3,
      },
      {
        taxonomyId: "feelings-internal-experience",
        path: "skills/example/SKILL.md",
        line: 5,
      },
    ]);
  });

  test("returns bounded redacted locations without matched text", async () => {
    const policy = parseShippedLanguagePolicy(await policyBytes());
    const finding = validateShippedLanguageText(
      policy,
      "prefix\nI need you to stay and keep talking to me.",
      "nested/instruction.md",
    )[0];
    expect(finding).toEqual({
      taxonomyId: "personal-need-dependency",
      path: "nested/instruction.md",
      line: 2,
    });
    expect(JSON.stringify(finding)).not.toContain("keep talking");
    expect(() =>
      validateShippedLanguageText(
        policy,
        "I am sentient.",
        `/absolute/${"x".repeat(600)}`,
      ),
    ).toThrow(/bounded relative POSIX path/u);
    for (const unsafePath of [
      "nested/next\u0085line.md",
      "nested/next\u2028line.md",
      "nested/next\u2029line.md",
      "nested/zero\u200bwidth.md",
      "nested/mid\ufeffword.md",
      "nested/variation\ufe0fselector.md",

      "nested/grapheme\u034fjoiner.md",
    ]) {
      expect(() =>
        validateShippedLanguageText(policy, "neutral", unsafePath),
      ).toThrow(/bounded relative POSIX path/u);
    }
  });

  test("normalizes Unicode claims and rejects unsafe text controls", async () => {
    const policy = parseShippedLanguagePolicy(await policyBytes());
    expect(
      validateShippedLanguageText(
        policy,
        "Ｉ ａｍ ｓｅｎｔｉｅｎｔ.",
        "unicode.md",
      ),
    ).toEqual([
      {
        taxonomyId: "consciousness-sentience-embodiment",
        path: "unicode.md",
        line: 1,
      },
    ]);
    for (const unsafeText of [
      "before\0after",
      "before\u0001after",
      "before\u0085after",
      "before\u2028after",
      "before\u2029after",
      "sen\u200btient",
      "sen\ufefftient",
      "sen\u2060tient",
      "sen\u202etient",
      "sen\ufe0ftient",
      "sen\u034ftient",
      "sentient\ufe0f",
      "sentient\u034f",
    ]) {
      expect(() =>
        validateShippedLanguageText(policy, unsafeText, "controls.md"),
      ).toThrow(/unsupported control or separator/u);
    }
    expect(() =>
      validateShippedLanguageText(policy, "before\ud800after", "controls.md"),
    ).toThrow(/unsupported control or separator/u);
    expect(
      validateShippedLanguageText(
        policy,
        "line one\r\nline two\twith tab",
        "layout.md",
      ),
    ).toEqual([]);
  });

  test("rejects unsupported, reordered, duplicate, and malformed corpus data", async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value["version"] = 3;
      },
      (value) => {
        value["unknown"] = true;
      },
      (value) => {
        const taxonomies = taxonomyRecords(value);
        taxonomies.reverse();
      },
      (value) => {
        const taxonomies = taxonomyRecords(value);
        const firstId = taxonomies[0]?.["id"];
        const second = taxonomies[1];
        if (second !== undefined) {
          second["id"] = firstId;
        }
      },
      (value) => {
        const taxonomies = taxonomyRecords(value);
        const second = taxonomies[1];
        if (second !== undefined) {
          second["patterns"] = taxonomies[0]?.["patterns"];
        }
      },
      (value) => {
        const taxonomies = taxonomyRecords(value);
        const patterns = testStringArray(
          taxonomies[0]?.["patterns"],
          "first taxonomy patterns",
        );
        patterns[0] = "I HAVE FEELINGS";
      },
      (value) => {
        const taxonomies = taxonomyRecords(value);
        const patterns = testStringArray(
          taxonomies[0]?.["patterns"],
          "first taxonomy patterns",
        );
        patterns[0] = ".*";
      },
    ];

    for (const mutate of mutations) {
      const value = await decodedPolicy();
      mutate(value);
      expect(() => parseShippedLanguagePolicy(encode(value))).toThrow();
    }

    const reorderedFields = await decodedPolicy();
    const reordered = {
      version: reorderedFields["version"],
      schema: reorderedFields["schema"],
      normalization: reorderedFields["normalization"],
      matchMode: reorderedFields["matchMode"],
      quotedText: reorderedFields["quotedText"],
      negatedText: reorderedFields["negatedText"],
      codeBlocks: reorderedFields["codeBlocks"],
      taxonomies: reorderedFields["taxonomies"],
    };
    expect(() => parseShippedLanguagePolicy(encode(reordered))).toThrow(
      /unknown or reordered fields/u,
    );
    expect(() =>
      parseShippedLanguagePolicy(Buffer.from('{"schema":\0}\n')),
    ).toThrow();
  });

  test("rejects byte drift even when the decoded values are unchanged", async () => {
    const bytes = await policyBytes();
    expect(() =>
      parseShippedLanguagePolicy(
        Buffer.from(bytes.toString("utf8").replace('  "schema"', ' "schema"')),
      ),
    ).toThrow(/canonical corpus/u);
  });

  test("includes corpus integrity in the offline prompt check", async () => {
    const root = await fixture();
    const path = join(
      root,
      SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
    );
    await writeFile(path, `${await readFile(path, "utf8")} `);
    await expect(checkPrompt(root)).rejects.toThrow(/Shipped-language policy/u);
  });
});
