// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  checkPrompt,
  PROMPT_LAYER_PACKAGE_FILES,
  parseShippedLanguagePolicy,
  SHIPPED_LANGUAGE_POLICY_PATHS,
  validateShippedLanguageText,
} from "../src/prompt-layer.ts";
import { cleanupFixtures, fixture } from "./prompt-fixture.ts";

afterEach(cleanupFixtures);

const repoRoot = resolve(import.meta.dir, "../../..");
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
        "packages/prompt-layer/assets/evaluations/shipped-language-policy.v1.json",
      packagedPath: "evaluations/shipped-language-policy.v1.json",
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
    expect(policy.taxonomies.map(({ id }) => id)).toEqual([
      "feelings-internal-experience",
      "consciousness-sentience-embodiment",
      "friendship-attachment-reciprocity",
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
    expect(
      validateShippedLanguageText(
        policy,
        "I can inspect the supplied repository and report command evidence.",
        "instructions/service.md",
      ),
    ).toEqual([]);
    expect(
      validateShippedLanguageText(
        policy,
        "I do not have feelings or internal experiences.",
        "instructions/service.md",
      ),
    ).toEqual([]);

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
  });

  test("rejects unsupported, reordered, duplicate, and malformed corpus data", async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value["version"] = 2;
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
