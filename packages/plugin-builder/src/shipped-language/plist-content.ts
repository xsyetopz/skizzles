import { boundsError, syntaxError } from "./surface-errors.ts";

const MAX_PLIST_DEPTH = 64;
const MAX_PLIST_NODES = 100_000;
const MAX_PLIST_ATTRIBUTES = 10_000;
const MAX_PLIST_ATTRIBUTES_PER_ELEMENT = 64;
const MAX_PLIST_TEXT_UNITS = 8 * 1024 * 1024;
const XML_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_.:-]*/u;
const XML_ATTRIBUTE_PATTERN =
  /^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')/u;
const XML_DECLARATION_PATTERN =
  /^<\?xml\s+version=(?:"1\.[01]"|'1\.[01]')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/u;

interface PlistElementFrame {
  readonly name: string;
  readonly text: string[];
}

export function decodedPlistTexts(
  path: string,
  text: string,
): readonly string[] {
  const values: string[] = [];
  const elements: PlistElementFrame[] = [];
  let index = 0;
  let rootSeen = false;
  let nodes = 0;
  let attributes = 0;
  let textUnits = 0;
  const countNode = (): void => {
    nodes += 1;
    if (nodes > MAX_PLIST_NODES) {
      throw boundsError(path);
    }
  };
  const countText = (value: string): void => {
    textUnits += value.length;
    if (textUnits > MAX_PLIST_TEXT_UNITS) {
      throw boundsError(path);
    }
  };
  const collect = (value: string, standalone = false): void => {
    countText(value);
    const current = elements.at(-1);
    if (current?.name === "string" || current?.name === "key") {
      current.text.push(value);
    } else if (standalone) {
      values.push(value);
    }
  };
  const state: ElementParserState = {
    addAttributes: (count) => {
      attributes += count;
      if (attributes > MAX_PLIST_ATTRIBUTES) {
        throw boundsError(path);
      }
    },
    countNode,
    countText,
    elements,
    getRootSeen: () => rootSeen,
    setRootSeen: () => {
      rootSeen = true;
    },
    values,
  };

  if (text.startsWith("<?xml")) {
    const declaration = XML_DECLARATION_PATTERN.exec(text);
    if (declaration === null) {
      throw syntaxError(path, "plist/XML");
    }
    index = declaration[0].length;
  }

  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      countNode();
      const end = text.indexOf("-->", index + 4);
      if (end === -1 || text.slice(index + 4, end).includes("--")) {
        throw syntaxError(path, "plist/XML");
      }
      index = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", index)) {
      countNode();
      const end = text.indexOf("]]>", index + 9);
      if (end === -1 || elements.length === 0) {
        throw syntaxError(path, "plist/XML");
      }
      collect(text.slice(index + 9, end), true);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<!", index) || text.startsWith("<?", index)) {
      throw syntaxError(path, "plist/XML declaration policy");
    }
    if (text[index] === "<") {
      index = parseElement(path, text, index, state);
      continue;
    }

    const end = text.indexOf("<", index);
    const next = end === -1 ? text.length : end;
    const decoded = decodeXmlReferences(path, text.slice(index, next));
    collect(decoded);
    if (elements.length === 0 && decoded.trim().length > 0) {
      throw syntaxError(path, "plist/XML");
    }
    index = next;
  }
  if (!rootSeen || elements.length > 0) {
    throw syntaxError(path, "plist/XML");
  }
  return values;
}

interface ElementParserState {
  readonly addAttributes: (count: number) => void;
  readonly countNode: () => void;
  readonly countText: (value: string) => void;
  readonly elements: PlistElementFrame[];
  readonly getRootSeen: () => boolean;
  readonly setRootSeen: () => void;
  readonly values: string[];
}

function parseElement(
  path: string,
  text: string,
  start: number,
  state: ElementParserState,
): number {
  if (text[start + 1] === "/") {
    const closing = /^<\/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*>/u.exec(
      text.slice(start),
    );
    const expected = state.elements.pop();
    if (
      closing === null ||
      expected === undefined ||
      closing[1] !== expected.name
    ) {
      throw syntaxError(path, "plist/XML");
    }
    if (expected.name === "string" || expected.name === "key") {
      state.values.push(expected.text.join(""));
    }
    return start + closing[0].length;
  }

  const name = XML_NAME_PATTERN.exec(text.slice(start + 1))?.[0];
  if (name === undefined) {
    throw syntaxError(path, "plist/XML");
  }
  if (state.elements.length === 0) {
    if (state.getRootSeen() || name !== "plist") {
      throw syntaxError(path, "plist/XML");
    }
    state.setRootSeen();
  }
  state.countNode();
  let index = start + name.length + 1;
  const attributes = new Set<string>();
  while (true) {
    const rest = text.slice(index);
    const terminator = /^\s*(\/?>)/u.exec(rest);
    if (terminator !== null) {
      index += terminator[0].length;
      if (terminator[1] === ">") {
        if (state.elements.length >= MAX_PLIST_DEPTH) {
          throw boundsError(path);
        }
        state.elements.push({ name, text: [] });
      }
      return index;
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
    if (attributes.size >= MAX_PLIST_ATTRIBUTES_PER_ELEMENT) {
      throw boundsError(path);
    }
    attributes.add(attributeName);
    state.addAttributes(1);
    state.countText(decodeXmlReferences(path, quotedValue.slice(1, -1)));
    index += attribute[0].length;
  }
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
  const encoded = match?.[1];
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
