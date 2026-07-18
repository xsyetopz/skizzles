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
  ["td", new Set(["align"])],
  ["th", new Set(["align"])],
]);
const BOOLEAN_HTML_ATTRIBUTES = new Set(["checked", "disabled"]);
const TABLE_ALIGNMENT_VALUES = new Set(["center", "left", "right"]);
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u;
const URL_SCHEME_PATTERN = /^(?<scheme>[a-z][a-z0-9+.-]*):/u;
const NUMERIC_CHARACTER_REFERENCE_PATTERN =
  /&#(?:(?<hexMarker>[xX])(?<hex>[0-9A-Fa-f]+)|(?<decimal>[0-9]+));?/gu;
const MAX_NAMED_REFERENCE_NAME_UNITS = 31;
const MAX_LEGACY_REFERENCE_NAME_UNITS = 6;
// 106 semicolon-optional WHATWG entities.json name=hex entries; SHA-256 d741d877ac77c4194c4ad526b5b4a19aef8dfe411ab840a466891cdbb9f362e6.
const LEGACY_NAMED_CHARACTER_REFERENCES = parseLegacyReferences(
  "AElig=c6 AMP=26 Aacute=c1 Acirc=c2 Agrave=c0 Aring=c5 Atilde=c3 Auml=c4 COPY=a9 Ccedil=c7 ETH=d0 Eacute=c9 Ecirc=ca Egrave=c8 Euml=cb GT=3e Iacute=cd Icirc=ce Igrave=cc Iuml=cf LT=3c Ntilde=d1 Oacute=d3 Ocirc=d4 Ograve=d2 Oslash=d8 Otilde=d5 Ouml=d6 QUOT=22 REG=ae THORN=de Uacute=da Ucirc=db Ugrave=d9 Uuml=dc Yacute=dd aacute=e1 acirc=e2 acute=b4 aelig=e6 agrave=e0 amp=26 aring=e5 atilde=e3 auml=e4 brvbar=a6 ccedil=e7 cedil=b8 cent=a2 copy=a9 curren=a4 deg=b0 divide=f7 eacute=e9 ecirc=ea egrave=e8 eth=f0 euml=eb frac12=bd frac14=bc frac34=be gt=3e iacute=ed icirc=ee iexcl=a1 igrave=ec iquest=bf iuml=ef laquo=ab lt=3c macr=af micro=b5 middot=b7 nbsp=a0 not=ac ntilde=f1 oacute=f3 ocirc=f4 ograve=f2 ordf=aa ordm=ba oslash=f8 otilde=f5 ouml=f6 para=b6 plusmn=b1 pound=a3 quot=22 raquo=bb reg=ae sect=a7 shy=ad sup1=b9 sup2=b2 sup3=b3 szlig=df thorn=fe times=d7 uacute=fa ucirc=fb ugrave=f9 uml=a8 uuml=fc yacute=fd yen=a5 yuml=ff",
);
const WINDOWS_1252_REFERENCE_REPLACEMENTS = new Map<number, number>([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
]);

interface ParsedHtmlTag {
  readonly attributes: ReadonlyMap<string, string | undefined>;
  readonly closing: boolean;
  readonly length: number;
  readonly name: string;
  readonly selfClosing: boolean;
  readonly visibleText: readonly string[];
}

function parseLegacyReferences(encoded: string): ReadonlyMap<string, string> {
  const references = new Map<string, string>();
  for (const entry of encoded.split(" ")) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    const scalar = Number.parseInt(entry.slice(separator + 1), 16);
    references.set(name, String.fromCodePoint(scalar));
  }
  return references;
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
      append(decodeHtmlText(path, rendered.slice(index), "data"));
      break;
    }
    append(decodeHtmlText(path, rendered.slice(index, start), "data"));
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
  return text.join("");
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
      value === undefined
        ? undefined
        : decodeHtmlText(path, value, "attribute");
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
  if (
    name === "align" &&
    (value === undefined || !TABLE_ALIGNMENT_VALUES.has(value))
  ) {
    throw policyError(path, "rendered Markdown HTML table alignment policy");
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

function decodeHtmlText(
  path: string,
  value: string,
  context: "attribute" | "data",
): string {
  const decoded: string[] = [];
  let index = 0;
  for (const match of value.matchAll(NUMERIC_CHARACTER_REFERENCE_PATTERN)) {
    const matchIndex = match.index;
    decoded.push(decodeNamedHtmlText(value.slice(index, matchIndex), context));
    const digits = match.groups?.["hex"] ?? match.groups?.["decimal"];
    if (digits === undefined) {
      throw syntaxError(path, "rendered Markdown HTML attribute text");
    }
    decoded.push(
      decodeNumericCharacterReference(
        digits,
        match.groups?.["hexMarker"] === undefined ? 10 : 16,
      ),
    );
    index = matchIndex + match[0].length;
  }
  decoded.push(decodeNamedHtmlText(value.slice(index), context));
  const text = decoded.join("");
  if (text.length > MAX_RENDERED_TEXT_UNITS) {
    throw boundsError(path);
  }
  return text;
}

function decodeNamedHtmlText(
  value: string,
  context: "attribute" | "data",
): string {
  const decoded: string[] = [];
  let index = 0;
  while (index < value.length) {
    const ampersand = value.indexOf("&", index);
    if (ampersand === -1) {
      decoded.push(value.slice(index));
      break;
    }
    decoded.push(value.slice(index, ampersand));
    const reference = matchNamedCharacterReference(value, ampersand, context);
    if (reference === undefined) {
      decoded.push("&");
      index = ampersand + 1;
      continue;
    }
    decoded.push(reference.decoded);
    index = ampersand + reference.units;
  }
  return decoded.join("");
}

function matchNamedCharacterReference(
  value: string,
  ampersand: number,
  context: "attribute" | "data",
): { readonly decoded: string; readonly units: number } | undefined {
  const nameStart = ampersand + 1;
  let nameUnits = 0;
  while (
    nameUnits < MAX_NAMED_REFERENCE_NAME_UNITS &&
    isAsciiAlphanumeric(value[nameStart + nameUnits])
  ) {
    nameUnits += 1;
  }
  if (nameUnits > 0 && value[nameStart + nameUnits] === ";") {
    const token = value.slice(ampersand, nameStart + nameUnits + 1);
    const decoded = Bun.markdown.render(token);
    if (decoded !== token) {
      return { decoded, units: token.length };
    }
  }
  const legacyLimit = Math.min(nameUnits, MAX_LEGACY_REFERENCE_NAME_UNITS);
  for (let units = legacyLimit; units > 0; units -= 1) {
    const decoded = LEGACY_NAMED_CHARACTER_REFERENCES.get(
      value.slice(nameStart, nameStart + units),
    );
    if (decoded === undefined) {
      continue;
    }
    const next = value[nameStart + units];
    if (
      context === "attribute" &&
      (next === "=" || isAsciiAlphanumeric(next))
    ) {
      return undefined;
    }
    return { decoded, units: units + 1 };
  }
  return undefined;
}

function isAsciiAlphanumeric(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const codePoint = value.charCodeAt(0);
  return (
    (codePoint >= 48 && codePoint <= 57) ||
    (codePoint >= 65 && codePoint <= 90) ||
    (codePoint >= 97 && codePoint <= 122)
  );
}

function decodeNumericCharacterReference(
  digits: string,
  radix: 10 | 16,
): string {
  const parsed = Number.parseInt(digits, radix);
  const replacement = WINDOWS_1252_REFERENCE_REPLACEMENTS.get(parsed) ?? parsed;
  const codePoint =
    parsed === 0 ||
    !Number.isFinite(parsed) ||
    parsed > 0x10ffff ||
    (parsed >= 0xd800 && parsed <= 0xdfff)
      ? 0xfffd
      : replacement;
  return String.fromCodePoint(codePoint);
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
