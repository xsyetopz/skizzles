import { boundsError, policyError, syntaxError } from "./surface-errors.ts";

const MAX_HTML_DEPTH = 64;
const MAX_HTML_NODES = 100_000;
const MAX_HTML_ATTRIBUTES = 100_000;
const MAX_HTML_ATTRIBUTES_PER_ELEMENT = 64;
const MAX_RENDERED_TEXT_UNITS = 8 * 1024 * 1024;
const HTML_TAG_START_PATTERN =
  /^<(?<closing>\/?)(?<name>[A-Za-z][A-Za-z0-9-]*)/u;
const HTML_ATTRIBUTE_PATTERN =
  /^\s+(?<name>[A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s"'=<>`]+)))?/u;
const HTML_TAG_END_PATTERN = /^\s*(?<selfClosing>\/?)>/u;
const HTML_VOID_ELEMENTS = new Set(["br", "hr", "img", "input"]);
const ALLOWED_HTML_ELEMENTS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const VISIBLE_HTML_ATTRIBUTES = new Set(["alt", "aria-label", "title"]);
const GLOBAL_HTML_ATTRIBUTES = new Set(["aria-label", "title"]);
const ELEMENT_HTML_ATTRIBUTES = new Map<string, ReadonlySet<string>>([
  ["a", new Set(["href"])],
  ["code", new Set(["class"])],
  ["img", new Set(["alt", "src"])],
  ["input", new Set(["checked", "class", "disabled", "type"])],
  ["li", new Set(["class"])],
  ["ol", new Set(["start"])],
]);
const BOOLEAN_HTML_ATTRIBUTES = new Set(["checked", "disabled"]);
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u;
const URL_SCHEME_PATTERN = /^(?<scheme>[a-z][a-z0-9+.-]*):/u;

interface ParsedHtmlTag {
  readonly attributes: ReadonlyMap<string, string | undefined>;
  readonly closing: boolean;
  readonly length: number;
  readonly name: string;
  readonly selfClosing: boolean;
  readonly visibleText: readonly string[];
}

export function decodedMarkdownText(path: string, text: string): string {
  let rendered: string;
  try {
    rendered = Bun.markdown.html(text);
  } catch {
    throw syntaxError(path, "Markdown");
  }
  if (rendered.length > MAX_RENDERED_TEXT_UNITS) {
    throw boundsError(path);
  }
  return extractRenderedHtmlText(path, rendered);
}

function extractRenderedHtmlText(path: string, rendered: string): string {
  const text: string[] = [];
  const elements: string[] = [];
  let units = 0;
  let index = 0;
  let nodes = 0;
  let attributes = 0;
  const append = (value: string): void => {
    units += value.length;
    if (units > MAX_RENDERED_TEXT_UNITS) {
      throw boundsError(path);
    }
    text.push(value);
  };
  const countNode = (): void => {
    nodes += 1;
    if (nodes > MAX_HTML_NODES) {
      throw boundsError(path);
    }
  };

  while (index < rendered.length) {
    const start = rendered.indexOf("<", index);
    if (start === -1) {
      append(rendered.slice(index));
      break;
    }
    append(rendered.slice(index, start));
    if (rendered.startsWith("<!--", start)) {
      countNode();
      const end = rendered.indexOf("-->", start + 4);
      if (end === -1 || rendered.slice(start + 4, end).includes("--")) {
        throw syntaxError(path, "rendered Markdown HTML");
      }
      index = end + 3;
      continue;
    }

    const tag = parseHtmlTag(path, rendered.slice(start));
    if (tag === undefined) {
      if (/^[A-Za-z/!?]/u.test(rendered[start + 1] ?? "")) {
        throw syntaxError(path, "rendered Markdown HTML");
      }
      append("<");
      index = start + 1;
      continue;
    }
    countNode();
    attributes += tag.attributes.size;
    if (attributes > MAX_HTML_ATTRIBUTES) {
      throw boundsError(path);
    }
    for (const visibleText of tag.visibleText) {
      append(` ${visibleText} `);
    }
    if (tag.closing) {
      if (elements.pop() !== tag.name || tag.selfClosing) {
        throw syntaxError(path, "rendered Markdown HTML");
      }
    } else if (!tag.selfClosing && !HTML_VOID_ELEMENTS.has(tag.name)) {
      if (elements.length >= MAX_HTML_DEPTH) {
        throw boundsError(path);
      }
      elements.push(tag.name);
    }
    index = start + tag.length;
  }
  if (elements.length > 0) {
    throw syntaxError(path, "rendered Markdown HTML");
  }
  let decoded: string;
  try {
    decoded = Bun.markdown.render(text.join(""));
  } catch {
    throw syntaxError(path, "rendered Markdown HTML text");
  }
  if (decoded.length > MAX_RENDERED_TEXT_UNITS) {
    throw boundsError(path);
  }
  return decoded;
}

function parseHtmlTag(path: string, input: string): ParsedHtmlTag | undefined {
  const start = HTML_TAG_START_PATTERN.exec(input);
  const name = start?.groups?.["name"]?.toLowerCase();
  if (start === null || name === undefined) {
    return undefined;
  }
  if (!ALLOWED_HTML_ELEMENTS.has(name)) {
    throw policyError(path, "rendered Markdown HTML element policy");
  }
  const closing = start.groups?.["closing"] === "/";
  const attributes = new Map<string, string | undefined>();
  const visibleText: string[] = [];
  let index = start[0].length;
  while (true) {
    const end = HTML_TAG_END_PATTERN.exec(input.slice(index));
    if (end !== null) {
      const selfClosing = end.groups?.["selfClosing"] === "/";
      if (closing && (attributes.size > 0 || selfClosing)) {
        throw syntaxError(path, "rendered Markdown HTML");
      }
      validateElementState(path, name, attributes);
      return {
        attributes,
        closing,
        length: index + end[0].length,
        name,
        selfClosing,
        visibleText,
      };
    }
    const attribute = HTML_ATTRIBUTE_PATTERN.exec(input.slice(index));
    const attributeName = attribute?.groups?.["name"]?.toLowerCase();
    if (
      attribute === null ||
      attributeName === undefined ||
      attributes.has(attributeName) ||
      attributes.size >= MAX_HTML_ATTRIBUTES_PER_ELEMENT
    ) {
      throw syntaxError(path, "rendered Markdown HTML attribute policy");
    }
    const value =
      attribute.groups?.["double"] ??
      attribute.groups?.["single"] ??
      attribute.groups?.["bare"];
    const decoded =
      value === undefined ? undefined : decodeHtmlText(path, value);
    validateAttribute(path, name, attributeName, decoded);
    attributes.set(attributeName, decoded);
    if (decoded !== undefined && VISIBLE_HTML_ATTRIBUTES.has(attributeName)) {
      visibleText.push(decoded);
    }
    index += attribute[0].length;
  }
}

function validateAttribute(
  path: string,
  element: string,
  name: string,
  value: string | undefined,
): void {
  const allowed =
    GLOBAL_HTML_ATTRIBUTES.has(name) ||
    ELEMENT_HTML_ATTRIBUTES.get(element)?.has(name) === true;
  if (
    !allowed ||
    name.startsWith("on") ||
    name.includes(":") ||
    (value === undefined) !== BOOLEAN_HTML_ATTRIBUTES.has(name) ||
    (value !== undefined && hasUnsafeAttributeText(value))
  ) {
    throw policyError(path, "rendered Markdown HTML attribute policy");
  }
  if ((name === "href" || name === "src") && value !== undefined) {
    validateUrl(path, name, value);
  }
}

function validateElementState(
  path: string,
  element: string,
  attributes: ReadonlyMap<string, string | undefined>,
): void {
  if (
    element === "input" &&
    (attributes.get("type")?.normalize("NFKC").toLowerCase() !== "checkbox" ||
      !attributes.has("disabled"))
  ) {
    throw policyError(path, "rendered Markdown HTML input policy");
  }
}

function validateUrl(path: string, attribute: string, value: string): void {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  const scheme = URL_SCHEME_PATTERN.exec(normalized)?.groups?.["scheme"];
  const allowedSchemes =
    attribute === "href" ? ["http", "https", "mailto"] : ["http", "https"];
  if (scheme !== undefined && !allowedSchemes.includes(scheme)) {
    throw policyError(path, "rendered Markdown HTML URL policy");
  }
}

function decodeHtmlText(path: string, value: string): string {
  let decoded: string;
  try {
    decoded = Bun.markdown.render(value);
  } catch {
    throw syntaxError(path, "rendered Markdown HTML attribute text");
  }
  if (decoded.length > MAX_RENDERED_TEXT_UNITS) {
    throw boundsError(path);
  }
  return decoded;
}

function hasUnsafeAttributeText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159) ||
      DEFAULT_IGNORABLE_PATTERN.test(character)
    ) {
      return true;
    }
  }
  return false;
}
