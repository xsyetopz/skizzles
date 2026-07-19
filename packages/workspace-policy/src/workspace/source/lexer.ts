export interface SourceToken {
  kind: "punctuation" | "string" | "word";
  value: string;
}

const REGULAR_EXPRESSION_PREFIX_WORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const HEX_DIGITS = /^[0-9a-f]+$/iu;
const IDENTIFIER_START = /[A-Z_a-z$]/u;
const IDENTIFIER_PART = /[0-9A-Z_a-z$]/u;
const WHITESPACE = /\s/u;

function tokenizeSource(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let index = 0;
  let regularExpressionAllowed = true;
  while (index < source.length) {
    const character = source[index];
    if (character === undefined) {
      break;
    }
    if (isWhitespace(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index + 2);
      continue;
    }
    if (character === "/" && regularExpressionAllowed) {
      index = skipRegularExpression(source, index + 1);
      regularExpressionAllowed = false;
      continue;
    }
    if (character === '"' || character === "'") {
      const literal = readString(source, index, character);
      tokens.push({ kind: "string", value: literal.value });
      index = literal.end;
      regularExpressionAllowed = false;
      continue;
    }
    if (character === "`") {
      index = skipTemplate(source, index + 1);
      regularExpressionAllowed = false;
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index] ?? "")) {
        index += 1;
      }
      const value = source.slice(start, index);
      tokens.push({ kind: "word", value });
      regularExpressionAllowed = REGULAR_EXPRESSION_PREFIX_WORDS.has(value);
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
    regularExpressionAllowed = punctuationAllowsRegularExpression(character);
  }
  return tokens;
}

function readString(
  source: string,
  start: number,
  quote: '"' | "'",
): { value: string; end: number } {
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === undefined) {
      break;
    }
    if (character === quote) {
      return { value, end: index + 1 };
    }
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    const decoded = readEscape(source, index + 1);
    value += decoded.value;
    index = decoded.end;
  }
  return { value, end: index };
}

function readEscape(
  source: string,
  start: number,
): { value: string; end: number } {
  const character = source[start];
  if (character === undefined) {
    return { value: "", end: start };
  }
  const simple: Readonly<Record<string, string>> = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  if (character in simple) {
    return { value: simple[character] ?? "", end: start + 1 };
  }
  if (character === "\n") {
    return { value: "", end: start + 1 };
  }
  if (character === "\r") {
    return {
      value: "",
      end: source[start + 1] === "\n" ? start + 2 : start + 1,
    };
  }
  if (character === "x") {
    return readCodePointEscape(source, start + 1, 2);
  }
  if (character === "u") {
    if (source[start + 1] === "{") {
      const close = source.indexOf("}", start + 2);
      if (close !== -1) {
        const value = Number.parseInt(source.slice(start + 2, close), 16);
        if (Number.isSafeInteger(value) && value <= 0x10_ffff) {
          return { value: String.fromCodePoint(value), end: close + 1 };
        }
      }
    }
    return readCodePointEscape(source, start + 1, 4);
  }
  return { value: character, end: start + 1 };
}

function readCodePointEscape(
  source: string,
  start: number,
  width: number,
): { value: string; end: number } {
  const digits = source.slice(start, start + width);
  if (digits.length === width && HEX_DIGITS.test(digits)) {
    return {
      value: String.fromCodePoint(Number.parseInt(digits, 16)),
      end: start + width,
    };
  }
  return { value: "", end: start };
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const close = source.indexOf("*/", start);
  return close === -1 ? source.length : close + 2;
}

function skipTemplate(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
    } else if (character === "`") {
      return index + 1;
    } else if (character === "$" && source[index + 1] === "{") {
      index = skipTemplateInterpolation(source, index + 2);
    } else {
      index += 1;
    }
  }
  return index;
}

function skipTemplateInterpolation(source: string, start: number): number {
  let index = start;
  let depth = 1;
  let regularExpressionAllowed = true;
  while (index < source.length) {
    const character = source[index];
    if (character === undefined) {
      return index;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index + 2);
    } else if (character === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index + 2);
    } else if (character === "/" && regularExpressionAllowed) {
      index = skipRegularExpression(source, index + 1);
      regularExpressionAllowed = false;
    } else if (character === '"' || character === "'") {
      index = readString(source, index, character).end;
      regularExpressionAllowed = false;
    } else if (character === "`") {
      index = skipTemplate(source, index + 1);
      regularExpressionAllowed = false;
    } else if (character === "{") {
      depth += 1;
      index += 1;
      regularExpressionAllowed = true;
    } else if (character === "}") {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return index;
      }
      regularExpressionAllowed = false;
    } else if (isIdentifierStart(character)) {
      const startOfWord = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index] ?? "")) {
        index += 1;
      }
      regularExpressionAllowed = REGULAR_EXPRESSION_PREFIX_WORDS.has(
        source.slice(startOfWord, index),
      );
    } else {
      index += 1;
      regularExpressionAllowed = punctuationAllowsRegularExpression(character);
    }
  }
  return index;
}

function skipRegularExpression(source: string, start: number): number {
  let index = start;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
    } else if (character === "[") {
      inCharacterClass = true;
      index += 1;
    } else if (character === "]") {
      inCharacterClass = false;
      index += 1;
    } else if (character === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && isIdentifierPart(source[index] ?? "")) {
        index += 1;
      }
      return index;
    } else if (character === "\n" || character === "\r") {
      return index;
    } else {
      index += 1;
    }
  }
  return index;
}

function punctuationAllowsRegularExpression(character: string): boolean {
  return !(
    character === ")" ||
    character === "]" ||
    character === "}" ||
    character === "+" ||
    character === "-"
  );
}

function isIdentifierStart(character: string): boolean {
  return IDENTIFIER_START.test(character) || character.charCodeAt(0) > 0x7f;
}

function isIdentifierPart(character: string): boolean {
  return IDENTIFIER_PART.test(character) || character.charCodeAt(0) > 0x7f;
}

function isWhitespace(character: string): boolean {
  return WHITESPACE.test(character);
}

export { tokenizeSource };
