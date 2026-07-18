import { basename, extname } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not follow yaml's package exports; yaml is a declared runtime dependency.
// biome-ignore lint/performance/noNamespaceImport: semantic scanning uses the parser's document, node predicates, and visitor as one boundary.
import * as Yaml from "yaml";
import { PackagingError } from "../plugin/contract.ts";
import { safeLanguageDiagnosticPath } from "./file-boundary.ts";

const MAX_SEMANTIC_DEPTH = 64;
const MAX_SEMANTIC_NODES = 100_000;
const MAX_SEMANTIC_TEXT_UNITS = 8 * 1024 * 1024;
const MAX_SURFACE_TEXT_UNITS = 16 * 1024 * 1024;
const XML_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_.:-]*/u;
const XML_ATTRIBUTE_PATTERN =
  /^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')/u;
const XML_DECLARATION_PATTERN =
  /^<\?xml\s+version=(?:"1\.[01]"|'1\.[01]')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/u;
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
  | "markdown"
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
      case "markdown":
        return [renderMarkdown(path, text)];
      case "plist":
        return decodedPlistTexts(path, text);
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
      return "markdown";
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
  const document = Yaml.parseDocument(text, {
    customTags: [],
    merge: false,
    prettyErrors: false,
    resolveKnownTags: true,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: false,
    version: "1.2",
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw syntaxError(path, "YAML");
  }
  const collector = new SemanticTextCollector(path);
  let nodes = 0;
  Yaml.visit(document, (_key, node) => {
    nodes += 1;
    if (nodes > MAX_SEMANTIC_NODES) {
      throw boundsError(path);
    }
    if (Yaml.isScalar(node) && typeof node.value === "string") {
      collector.add(node.value);
    }
  });
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: MAX_SEMANTIC_NODES });
  } catch {
    throw boundsError(path);
  }
  collector.visit(value);
  return collector.values();
}

class SemanticTextCollector {
  readonly #path: string;
  readonly #texts = new Set<string>();
  readonly #active = new WeakSet<object>();
  readonly #completed = new WeakSet<object>();
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
    if (this.#active.has(value)) {
      throw boundsError(this.#path);
    }
    if (this.#completed.has(value)) {
      return;
    }
    this.#active.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        this.visit(item, depth + 1);
      }
      this.#active.delete(value);
      this.#completed.add(value);
      return;
    }
    if (!isPlainRecord(value)) {
      throw parseError(this.#path, "structured text");
    }
    for (const [key, item] of Object.entries(value)) {
      this.add(key);
      this.visit(item, depth + 1);
    }
    this.#active.delete(value);
    this.#completed.add(value);
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

function renderMarkdown(path: string, text: string): string {
  let rendered: string;
  try {
    rendered = Bun.markdown.render(text);
  } catch {
    throw syntaxError(path, "Markdown");
  }
  if (rendered.length > MAX_SEMANTIC_TEXT_UNITS) {
    throw boundsError(path);
  }
  return rendered;
}

function decodedPlistTexts(path: string, text: string): readonly string[] {
  const values: string[] = [];
  const elements: string[] = [];
  let index = 0;
  let rootSeen = false;

  if (text.startsWith("<?xml")) {
    const declaration = XML_DECLARATION_PATTERN.exec(text);
    if (declaration === null) {
      throw syntaxError(path, "plist/XML");
    }
    index = declaration[0].length;
  }

  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      if (end === -1 || text.slice(index + 4, end).includes("--")) {
        throw syntaxError(path, "plist/XML");
      }
      index = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", index)) {
      const end = text.indexOf("]]>", index + 9);
      if (end === -1 || elements.length === 0) {
        throw syntaxError(path, "plist/XML");
      }
      values.push(text.slice(index + 9, end));
      index = end + 3;
      continue;
    }
    if (text.startsWith("<!", index) || text.startsWith("<?", index)) {
      throw syntaxError(path, "plist/XML declaration policy");
    }
    if (text[index] === "<") {
      if (text[index + 1] === "/") {
        const closing = /^<\/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*>/u.exec(
          text.slice(index),
        );
        const expected = elements.pop();
        if (
          closing === null ||
          expected === undefined ||
          closing[1] !== expected
        ) {
          throw syntaxError(path, "plist/XML");
        }
        index += closing[0].length;
        continue;
      }
      const name = XML_NAME_PATTERN.exec(text.slice(index + 1))?.[0];
      if (name === undefined) {
        throw syntaxError(path, "plist/XML");
      }
      if (elements.length === 0) {
        if (rootSeen || name !== "plist") {
          throw syntaxError(path, "plist/XML");
        }
        rootSeen = true;
      }
      index += name.length + 1;
      const attributes = new Set<string>();
      while (true) {
        const rest = text.slice(index);
        const terminator = /^\s*(\/?>)/u.exec(rest);
        if (terminator !== null) {
          index += terminator[0].length;
          if (terminator[1] === ">") {
            elements.push(name);
          }
          break;
        }
        const attribute = XML_ATTRIBUTE_PATTERN.exec(rest);
        const attributeName = attribute?.[1];
        const quotedValue = attribute?.[2];
        if (
          attribute === null ||
          attributeName === undefined ||
          quotedValue === undefined ||
          attributes.has(attributeName)
        ) {
          throw syntaxError(path, "plist/XML");
        }
        attributes.add(attributeName);
        decodeXmlReferences(path, quotedValue.slice(1, -1));
        index += attribute[0].length;
      }
      continue;
    }

    const end = text.indexOf("<", index);
    const next = end === -1 ? text.length : end;
    const decoded = decodeXmlReferences(path, text.slice(index, next));
    const current = elements.at(-1);
    if (current === "string" || current === "key") {
      values.push(decoded);
    } else if (elements.length === 0 && decoded.trim().length > 0) {
      throw syntaxError(path, "plist/XML");
    }
    index = next;
  }
  if (!rootSeen || elements.length > 0) {
    throw syntaxError(path, "plist/XML");
  }
  return values;
}

function decodeXmlReferences(path: string, value: string): string {
  let decoded = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === "<" || value.startsWith("]]>", index)) {
      throw syntaxError(path, "plist/XML");
    }
    if (character !== "&") {
      decoded += character;
      index += 1;
      continue;
    }
    const end = value.indexOf(";", index + 1);
    if (end === -1 || end - index > 32) {
      throw syntaxError(path, "plist/XML entity policy");
    }
    const entity = value.slice(index + 1, end);
    const named = predefinedXmlEntity(entity);
    decoded += named ?? numericXmlEntity(path, entity);
    index = end + 1;
  }
  return decoded;
}

function predefinedXmlEntity(entity: string): string | undefined {
  return { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' }[entity];
}

function numericXmlEntity(path: string, entity: string): string {
  const match = /^#(x[0-9A-Fa-f]+|[0-9]+)$/u.exec(entity);
  if (match === null) {
    throw syntaxError(path, "plist/XML entity policy");
  }
  const encoded = match[1];
  if (encoded === undefined) {
    throw syntaxError(path, "plist/XML entity policy");
  }
  const hexadecimal = encoded.startsWith("x");
  const digits = hexadecimal ? encoded.slice(1) : encoded;
  const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (!isXmlCodePoint(codePoint)) {
    throw syntaxError(path, "plist/XML entity");
  }
  return String.fromCodePoint(codePoint);
}

function isXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 9 ||
    codePoint === 10 ||
    codePoint === 13 ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
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
