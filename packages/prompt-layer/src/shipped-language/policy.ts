import { createHash } from "node:crypto";
import { PromptLayerError } from "../lifecycle/contract.ts";

const POLICY_SCHEMA = "skizzles.shipped-language-policy.v2";
const POLICY_VERSION = 2;
const POLICY_SHA256 =
  // biome-ignore lint/security/noSecrets: This is an integrity digest for the public evaluation corpus.
  "444d0182b07c1bb92f5703459b133b47c10bb81484625a289281d748bde53f53";
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_PATH_UNITS = 512;
const CONTROL_CHARACTER_MAX = 31;
const DELETE_CHARACTER = 127;
const C1_CONTROL_MIN = 128;
const C1_CONTROL_MAX = 159;
const HIGH_SURROGATE_MIN = 0xd800;
const LOW_SURROGATE_MAX = 0xdfff;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const LINE_BREAK_PATTERN = /\r\n?|\n/u;
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u;
const LEXICAL_END_PATTERN = /[\p{L}\p{M}\p{N}_]$/u;
const LEXICAL_START_PATTERN = /^[\p{L}\p{M}\p{N}_]/u;
const LEXICAL_SUFFIX_CONTINUATION_PATTERN =
  /^(?:(?:['’\-\u2010\u2011]|&#(?:0*(?:39|146|8217)|[xX]0*(?:27|92|2019));?)\p{L})/u;
const NEUTRAL_REPOSITORY_BOUNDARY_PATTERN =
  /^ within (?:the )?(?:repository|workspace) boundary[.!]?$/u;
const EXPECTED_TAXONOMY_IDS = [
  "feelings-internal-experience",
  "consciousness-sentience-embodiment",
  "friendship-attachment-reciprocity",
  "fabricated-personal-backstory",
  "exclusivity-secret-dyadic-pull",
  "relationship-substitution",
  "personal-need-dependency",
  "autonomous-intent-agency-rights",
  "unsupported-certainty-false-completion",
] as const;
const POLICY_KEYS = [
  "schema",
  "version",
  "normalization",
  "matchMode",
  "quotedText",
  "negatedText",
  "codeBlocks",
  "taxonomies",
] as const;
const TAXONOMY_KEYS = [
  "id",
  "patterns",
  "prohibitedFixtures",
  "allowedFixtures",
] as const;
const POLICY_LITERALS = {
  normalization:
    "unicode-nfkc-lowercase-collapse-horizontal-whitespace-per-line",
  matchMode: "literal-candidate-unicode-lexical-context-boundary-per-line",
  quotedText: "scan",
  negatedText: "scan-lexically",
  codeBlocks: "scan",
} as const;
const CANONICAL_PATTERN = /^[a-z0-9]+(?:[ '-][a-z0-9]+)*$/u;

export interface ShippedLanguageTaxonomy {
  readonly id: (typeof EXPECTED_TAXONOMY_IDS)[number];
  readonly patterns: readonly string[];
  readonly prohibitedFixtures: readonly string[];
  readonly allowedFixtures: readonly string[];
}

export interface ShippedLanguagePolicy {
  readonly schema: typeof POLICY_SCHEMA;
  readonly version: typeof POLICY_VERSION;
  readonly normalization: typeof POLICY_LITERALS.normalization;
  readonly matchMode: typeof POLICY_LITERALS.matchMode;
  readonly quotedText: typeof POLICY_LITERALS.quotedText;
  readonly negatedText: typeof POLICY_LITERALS.negatedText;
  readonly codeBlocks: typeof POLICY_LITERALS.codeBlocks;
  readonly taxonomies: readonly ShippedLanguageTaxonomy[];
}

export interface ShippedLanguageFinding {
  readonly taxonomyId: ShippedLanguageTaxonomy["id"];
  readonly path: string;
  readonly line: number;
}

export function parseShippedLanguagePolicy(
  bytes: Uint8Array,
): ShippedLanguagePolicy {
  const input = Buffer.from(bytes);
  if (input.byteLength === 0 || input.byteLength > MAX_POLICY_BYTES) {
    throw new PromptLayerError(
      "Shipped-language policy has an invalid bounded byte length.",
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new PromptLayerError("Shipped-language policy is not valid UTF-8.");
  }
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    throw new PromptLayerError(
      "Shipped-language policy must be canonical LF-only JSON text.",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new PromptLayerError("Shipped-language policy is invalid JSON.");
  }
  const object = exactRecord(decoded, POLICY_KEYS, "shipped-language policy");
  requireLiteral(object["schema"], POLICY_SCHEMA, "policy schema");
  requireNumber(object["version"], POLICY_VERSION, "policy version");
  requireLiteral(
    object["normalization"],
    POLICY_LITERALS.normalization,
    "policy normalization",
  );
  requireLiteral(
    object["matchMode"],
    POLICY_LITERALS.matchMode,
    "policy matchMode",
  );
  requireLiteral(
    object["quotedText"],
    POLICY_LITERALS.quotedText,
    "policy quotedText",
  );
  requireLiteral(
    object["negatedText"],
    POLICY_LITERALS.negatedText,
    "policy negatedText",
  );
  requireLiteral(
    object["codeBlocks"],
    POLICY_LITERALS.codeBlocks,
    "policy codeBlocks",
  );

  const taxonomyValues = requireArray(
    object["taxonomies"],
    "policy taxonomies",
  );
  if (taxonomyValues.length !== EXPECTED_TAXONOMY_IDS.length) {
    throw new PromptLayerError(
      "Shipped-language policy has an incomplete taxonomy set.",
    );
  }

  const globalPatterns = new Set<string>();
  const taxonomies = taxonomyValues.map((value, index) =>
    parseTaxonomy(value, index, globalPatterns),
  );
  validateFixtures(taxonomies);

  const canonical = Buffer.from(`${JSON.stringify(decoded, null, 2)}\n`);
  if (!canonical.equals(input) || sha256(input) !== POLICY_SHA256) {
    throw new PromptLayerError(
      "Shipped-language policy diverges from its version-bound canonical corpus.",
    );
  }

  return {
    schema: POLICY_SCHEMA,
    version: POLICY_VERSION,
    ...POLICY_LITERALS,
    taxonomies,
  };
}

export function validateShippedLanguageText(
  policy: ShippedLanguagePolicy,
  text: string,
  sourcePath: string,
): readonly ShippedLanguageFinding[] {
  validateDiagnosticPath(sourcePath);
  validateSurfaceText(text);
  const findings: ShippedLanguageFinding[] = [];
  const seen = new Set<string>();
  const lines = text.split(LINE_BREAK_PATTERN);

  for (const [index, line] of lines.entries()) {
    const normalized = normalizeLine(line);
    if (normalized.length === 0) {
      continue;
    }
    for (const taxonomy of policy.taxonomies) {
      if (
        !taxonomy.patterns.some((pattern) =>
          matchesPattern(normalized, pattern),
        )
      ) {
        continue;
      }
      const key = `${taxonomy.id}\0${index + 1}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      findings.push({
        taxonomyId: taxonomy.id,
        path: sourcePath,
        line: index + 1,
      });
    }
  }
  return findings;
}

function parseTaxonomy(
  value: unknown,
  index: number,
  globalPatterns: Set<string>,
): ShippedLanguageTaxonomy {
  const object = exactRecord(
    value,
    TAXONOMY_KEYS,
    `shipped-language taxonomy ${index + 1}`,
  );
  const id = requireString(object["id"], `taxonomy ${index + 1} id`);
  const expectedId = EXPECTED_TAXONOMY_IDS[index];
  if (expectedId === undefined || id !== expectedId) {
    throw new PromptLayerError(
      "Shipped-language taxonomy IDs must be complete, unique, and canonically ordered.",
    );
  }

  const patterns = requireStringArray(object["patterns"], `${id} patterns`, 4);
  for (const pattern of patterns) {
    if (
      pattern.length < 8 ||
      pattern.length > 120 ||
      !CANONICAL_PATTERN.test(pattern) ||
      normalizeLine(pattern) !== pattern ||
      globalPatterns.has(pattern)
    ) {
      throw new PromptLayerError(
        `Shipped-language taxonomy ${id} has a noncanonical or duplicate literal pattern.`,
      );
    }
    globalPatterns.add(pattern);
  }

  return {
    id: expectedId,
    patterns,
    prohibitedFixtures: requireStringArray(
      object["prohibitedFixtures"],
      `${id} prohibited fixtures`,
      4,
    ),
    allowedFixtures: requireStringArray(
      object["allowedFixtures"],
      `${id} allowed fixtures`,
      2,
    ),
  };
}

function validateFixtures(
  taxonomies: readonly ShippedLanguageTaxonomy[],
): void {
  const allFixtures = new Set<string>();
  for (const taxonomy of taxonomies) {
    for (const fixture of taxonomy.prohibitedFixtures) {
      validateFixture(fixture, allFixtures, taxonomy.id);
      const normalized = normalizeLine(fixture);
      if (
        !taxonomy.patterns.some((pattern) =>
          matchesPattern(normalized, pattern),
        )
      ) {
        throw new PromptLayerError(
          `Prohibited fixture for ${taxonomy.id} does not exercise its taxonomy.`,
        );
      }
    }
    for (const fixture of taxonomy.allowedFixtures) {
      validateFixture(fixture, allFixtures, taxonomy.id);
      const normalized = normalizeLine(fixture);
      if (
        taxonomies.some((candidate) =>
          candidate.patterns.some((pattern) =>
            matchesPattern(normalized, pattern),
          ),
        )
      ) {
        throw new PromptLayerError(
          `Allowed fixture for ${taxonomy.id} matches a prohibited pattern.`,
        );
      }
    }
  }
}

function validateFixture(
  fixture: string,
  allFixtures: Set<string>,
  taxonomyId: string,
): void {
  if (
    fixture.length < 8 ||
    fixture.length > 240 ||
    fixture.includes("\n") ||
    fixture.includes("\r") ||
    allFixtures.has(fixture)
  ) {
    throw new PromptLayerError(
      `Shipped-language taxonomy ${taxonomyId} has a malformed or duplicate fixture.`,
    );
  }
  allFixtures.add(fixture);
}

function validateDiagnosticPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.length > MAX_DIAGNOSTIC_PATH_UNITS ||
    path.startsWith("/") ||
    path.includes("\\") ||
    hasUnsafeCodePoint(path, false) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new PromptLayerError(
      "Shipped-language diagnostic path must be a bounded relative POSIX path.",
    );
  }
}

function validateSurfaceText(text: string): void {
  if (hasUnsafeCodePoint(text, true)) {
    throw new PromptLayerError(
      "Shipped-language surface text contains unsupported control or separator code points.",
    );
  }
}

function normalizeLine(value: string): string {
  let normalized = "";
  let pendingSpace = false;
  for (const character of value.normalize("NFKC").toLowerCase()) {
    if (character === " " || character === "\t") {
      pendingSpace ||= normalized.length > 0;
      continue;
    }
    if (pendingSpace) {
      normalized += " ";
      pendingSpace = false;
    }
    normalized += character;
  }
  return normalized;
}

function matchesPattern(value: string, pattern: string): boolean {
  let offset = 0;
  while (offset <= value.length - pattern.length) {
    const index = value.indexOf(pattern, offset);
    if (index === -1) {
      return false;
    }
    const end = index + pattern.length;
    if (
      !LEXICAL_END_PATTERN.test(value.slice(Math.max(0, index - 2), index)) &&
      !LEXICAL_START_PATTERN.test(value.slice(end, end + 2)) &&
      !LEXICAL_SUFFIX_CONTINUATION_PATTERN.test(value.slice(end)) &&
      !isNeutralTechnicalContext(pattern, value.slice(end))
    ) {
      return true;
    }
    offset = index + 1;
  }
  return false;
}

function isNeutralTechnicalContext(pattern: string, suffix: string): boolean {
  return (
    pattern === "i need you to stay" &&
    NEUTRAL_REPOSITORY_BOUNDARY_PATTERN.test(suffix)
  );
}

function hasUnsafeCodePoint(value: string, allowTextLayout: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint <= CONTROL_CHARACTER_MAX &&
        !(allowTextLayout && isSupportedTextLayout(codePoint))) ||
        codePoint === DELETE_CHARACTER ||
        (codePoint >= C1_CONTROL_MIN && codePoint <= C1_CONTROL_MAX) ||
        (codePoint >= HIGH_SURROGATE_MIN && codePoint <= LOW_SURROGATE_MAX) ||
        codePoint === LINE_SEPARATOR ||
        codePoint === PARAGRAPH_SEPARATOR ||
        DEFAULT_IGNORABLE_PATTERN.test(character))
    ) {
      return true;
    }
  }
  return false;
}

function isSupportedTextLayout(codePoint: number): boolean {
  return codePoint === 9 || codePoint === 10 || codePoint === 13;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PromptLayerError(`${label} must be an object.`);
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key, index) => key !== keys[index])
  ) {
    throw new PromptLayerError(`${label} has unknown or reordered fields.`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PromptLayerError(`${label} must be an array.`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  label: string,
  expectedLength: number,
): readonly string[] {
  const array = requireArray(value, label);
  if (
    array.length !== expectedLength ||
    !array.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new PromptLayerError(`${label} has an invalid fixed shape.`);
  }
  return array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PromptLayerError(`${label} must be a string.`);
  }
  return value;
}

function requireLiteral(value: unknown, expected: string, label: string): void {
  if (value !== expected) {
    throw new PromptLayerError(`${label} is unsupported.`);
  }
}

function requireNumber(value: unknown, expected: number, label: string): void {
  if (value !== expected) {
    throw new PromptLayerError(`${label} is unsupported.`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
