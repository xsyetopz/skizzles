import { basename, extname } from "node:path";
import { PackagingError } from "../plugin/contract.ts";
import { safeLanguageDiagnosticPath } from "./file-boundary.ts";

const MAX_SEMANTIC_DEPTH = 64;
const MAX_SEMANTIC_NODES = 100_000;
const MAX_SEMANTIC_TEXT_UNITS = 8 * 1024 * 1024;
const MAX_SURFACE_TEXT_UNITS = 16 * 1024 * 1024;
const XML_ENTITY_PATTERN =
  /&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/gu;
const XML_ENTITY_DECLARATION_PATTERN = /<!ENTITY\b/iu;
const UNRESOLVED_XML_ENTITY_PATTERN = /&(?:#[^;\s]+|[A-Za-z_:][^;\s]*);/u;
const SYNTAX_ERROR_NAME = "LanguageSurfaceSyntaxError";
const TYPESCRIPT_TRANSPILER = new Bun.Transpiler({
  loader: "ts",
  target: "bun",
});
const JAVASCRIPT_TRANSPILER = new Bun.Transpiler({
  loader: "js",
  target: "bun",
});

const STAGED_EXTENSIONLESS_SURFACES = new Set([
  "skills/codex-container-lab/scripts/codex-container-lab",
  "skills/designer-runtime/scripts/designer-sim",
]);
const CANONICAL_EXTENSIONLESS_DIAGNOSTIC_DEFER = new Set([
  "packages/plugin-builder/template/third_party/openai-codex/COPYING",
]);

type SurfaceKind =
  | "javascript"
  | "json"
  | "jsonc"
  | "plist"
  | "text"
  | "typescript"
  | "yaml";

export function semanticSurfaceTexts(
  path: string,
  text: string,
  mode: "canonical" | "staged",
): readonly string[] {
  if (text.length > MAX_SURFACE_TEXT_UNITS) {
    throw boundsError(path);
  }
  const kind = classifySurface(path, mode);
  try {
    switch (kind) {
      case "json":
        return decodedJsonTexts(path, text, false);
      case "jsonc":
        return decodedJsonTexts(path, text, true);
      case "yaml":
        return decodedYamlTexts(path, text);
      case "typescript":
        return [transpile(path, text, TYPESCRIPT_TRANSPILER)];
      case "javascript":
        return [transpile(path, text, JAVASCRIPT_TRANSPILER)];
      case "plist":
        return [decodePlistEntities(path, text)];
      case "text":
        return [];
    }
  } catch (error) {
    if (mode === "canonical" && isLanguageSurfaceSyntaxError(error)) {
      return [];
    }
    throw error;
  }
}

function classifySurface(
  path: string,
  mode: "canonical" | "staged",
): SurfaceKind {
  const name = basename(path);
  const extension = extname(name).toLowerCase();
  if (extension === "") {
    if (name === ".gitignore") {
      return "text";
    }
    if (STAGED_EXTENSIONLESS_SURFACES.has(path)) {
      return "text";
    }
    if (
      mode === "canonical" &&
      CANONICAL_EXTENSIONLESS_DIAGNOSTIC_DEFER.has(path)
    ) {
      return "text";
    }
    if (mode === "canonical" && name.startsWith(".")) {
      return "text";
    }
    throw classificationError(path, mode);
  }
  switch (extension) {
    case ".json":
      return "json";
    case ".jsonc":
      return "jsonc";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".ts":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".plist":
      return "plist";
    case ".md":
      return "text";
    default:
      if (mode === "canonical") {
        return "text";
      }
      throw classificationError(path, mode);
  }
}

function decodedJsonTexts(
  path: string,
  text: string,
  allowComments: boolean,
): readonly string[] {
  let value: unknown;
  try {
    value = allowComments ? Bun.JSONC.parse(text) : JSON.parse(text);
  } catch {
    throw syntaxError(path, allowComments ? "JSONC" : "JSON");
  }
  const collector = new SemanticTextCollector(path);
  collector.visit(value);
  for (const token of jsonStringTokens(path, text, allowComments)) {
    collector.add(token);
  }
  return collector.values();
}

function decodedYamlTexts(path: string, text: string): readonly string[] {
  let value: unknown;
  try {
    value = Bun.YAML.parse(text);
  } catch {
    throw syntaxError(path, "YAML");
  }
  const collector = new SemanticTextCollector(path);
  collector.visit(value);
  for (const token of yamlQuotedScalars(path, text)) {
    collector.add(token);
  }
  return collector.values();
}

class SemanticTextCollector {
  readonly #path: string;
  readonly #texts = new Set<string>();
  readonly #visited = new WeakSet<object>();
  #nodes = 0;
  #textUnits = 0;

  constructor(path: string) {
    this.#path = path;
  }

  add(value: string): void {
    if (this.#texts.has(value)) {
      return;
    }
    this.#textUnits += value.length;
    if (this.#textUnits > MAX_SEMANTIC_TEXT_UNITS) {
      throw boundsError(this.#path);
    }
    this.#texts.add(value);
  }

  visit(value: unknown, depth = 0): void {
    this.#nodes += 1;
    if (depth > MAX_SEMANTIC_DEPTH || this.#nodes > MAX_SEMANTIC_NODES) {
      throw boundsError(this.#path);
    }
    if (typeof value === "string") {
      this.add(value);
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    if (this.#visited.has(value)) {
      throw boundsError(this.#path);
    }
    this.#visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        this.visit(item, depth + 1);
      }
      return;
    }
    if (!isPlainRecord(value)) {
      throw parseError(this.#path, "structured text");
    }
    for (const [key, item] of Object.entries(value)) {
      this.add(key);
      this.visit(item, depth + 1);
    }
  }

  values(): readonly string[] {
    return [...this.#texts];
  }
}

function jsonStringTokens(
  path: string,
  text: string,
  allowComments: boolean,
): readonly string[] {
  const decoded: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (allowComments && text[index] === "/" && text[index + 1] === "/") {
      index = skipLineComment(text, index + 2);
      continue;
    }
    if (allowComments && text[index] === "/" && text[index + 1] === "*") {
      index = skipBlockComment(path, text, index + 2);
      continue;
    }
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const end = quotedEnd(path, text, index, '"', false);
    try {
      const value: unknown = JSON.parse(text.slice(index, end));
      if (typeof value !== "string") {
        throw parseError(path, "JSON string");
      }
      decoded.push(value);
    } catch {
      throw parseError(path, "JSON string");
    }
    index = end;
  }
  return decoded;
}

function yamlQuotedScalars(path: string, text: string): readonly string[] {
  const decoded: string[] = [];
  let index = 0;
  let lineStart = true;
  while (index < text.length) {
    const character = text[index];
    if (character === "\n" || character === "\r") {
      lineStart = true;
      index += 1;
      continue;
    }
    if (character === "#") {
      index = skipLineComment(text, index + 1);
      lineStart = true;
      continue;
    }
    if (
      (character === '"' || character === "'") &&
      isYamlScalarStart(text, index, lineStart)
    ) {
      const end = quotedEnd(path, text, index, character, character === "'");
      const snippet = `value: ${text.slice(index, end)}\n`;
      let parsed: unknown;
      try {
        parsed = Bun.YAML.parse(snippet);
      } catch {
        throw parseError(path, "YAML scalar");
      }
      if (!isPlainRecord(parsed) || typeof parsed["value"] !== "string") {
        throw parseError(path, "YAML scalar");
      }
      decoded.push(parsed["value"]);
      index = end;
      lineStart = false;
      continue;
    }
    if (character !== " " && character !== "\t") {
      lineStart = false;
    }
    index += 1;
  }
  return decoded;
}

function isYamlScalarStart(
  text: string,
  index: number,
  lineStart: boolean,
): boolean {
  if (lineStart) {
    return true;
  }
  let previous = index - 1;
  while (previous >= 0 && (text[previous] === " " || text[previous] === "\t")) {
    previous -= 1;
  }
  const character = text[previous];
  return (
    character === undefined ||
    character === ":" ||
    character === "," ||
    character === "-" ||
    character === "[" ||
    character === "{"
  );
}

function quotedEnd(
  path: string,
  text: string,
  start: number,
  quote: string,
  doubledQuote: boolean,
): number {
  let index = start + 1;
  while (index < text.length) {
    if (!doubledQuote && text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) {
      if (doubledQuote && text[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  throw parseError(path, "quoted string");
}

function skipLineComment(text: string, start: number): number {
  const end = text.indexOf("\n", start);
  return end === -1 ? text.length : end + 1;
}

function skipBlockComment(path: string, text: string, start: number): number {
  const end = text.indexOf("*/", start);
  if (end === -1) {
    throw parseError(path, "JSONC comment");
  }
  return end + 2;
}

function transpile(
  path: string,
  text: string,
  transpiler: Bun.Transpiler,
): string {
  try {
    return transpiler.transformSync(text);
  } catch {
    throw syntaxError(path, "JavaScript/TypeScript");
  }
}

function decodePlistEntities(path: string, text: string): string {
  if (XML_ENTITY_DECLARATION_PATTERN.test(text)) {
    throw parseError(path, "plist entity policy");
  }
  const decoded = text.replace(XML_ENTITY_PATTERN, (entity) => {
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default:
        return numericXmlEntity(path, entity);
    }
  });
  if (UNRESOLVED_XML_ENTITY_PATTERN.test(decoded)) {
    throw parseError(path, "plist entity policy");
  }
  return decoded;
}

function numericXmlEntity(path: string, entity: string): string {
  const hexadecimal = entity.startsWith("&#x");
  const digits = entity.slice(hexadecimal ? 3 : 2, -1);
  const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    throw parseError(path, "plist entity");
  }
  return String.fromCodePoint(codePoint);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function classificationError(
  path: string,
  mode: "canonical" | "staged",
): PackagingError {
  const owner = mode === "canonical" ? "Canonical candidate" : "Staged shipped";
  return new PackagingError(
    `${owner} file ${safeLanguageDiagnosticPath(path)} has no explicit language-policy surface classification.`,
  );
}

function parseError(path: string, format: string): PackagingError {
  return new PackagingError(
    `Shipped language surface ${safeLanguageDiagnosticPath(path)} is not valid bounded ${format}.`,
  );
}

function syntaxError(path: string, format: string): PackagingError {
  const error = new PackagingError(
    `Shipped language surface ${safeLanguageDiagnosticPath(path)} is not valid bounded ${format}.`,
  );
  error.name = SYNTAX_ERROR_NAME;
  return error;
}

function isLanguageSurfaceSyntaxError(error: unknown): boolean {
  return error instanceof PackagingError && error.name === SYNTAX_ERROR_NAME;
}

function boundsError(path: string): PackagingError {
  return new PackagingError(
    `Shipped language surface ${safeLanguageDiagnosticPath(path)} exceeds semantic scan bounds.`,
  );
}
