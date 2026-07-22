import type { SqlToken, SqlTokenizationResult } from "./contracts.ts";

const KEYWORDS = new Set([
  "ALTER",
  "BEGIN",
  "CASCADE",
  "COMMIT",
  "CONCURRENTLY",
  "CREATE",
  "DELETE",
  "DROP",
  "FROM",
  "IF",
  "INDEX",
  "INSERT",
  "INTO",
  "LOCK",
  "NOT",
  "NULL",
  "ON",
  "OR",
  "RENAME",
  "ROLLBACK",
  "SELECT",
  "SEQUENCE",
  "TABLE",
  "TYPE",
  "UPDATE",
  "VALUES",
  "WHERE",
  "WITH",
]);

const PUNCTUATION = new Set(["(", ")", ",", ";", ".", "=", "*", "+", "-", "/"]);

function isSpace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r"
  );
}

function isIdentifierStart(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
  );
}

function isIdentifierPart(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    isIdentifierStart(character) || (code >= 48 && code <= 57) || code === 36
  );
}

function isDigit(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code >= 48 && code <= 57;
}

function dollarDelimiter(source: string, start: number): string | undefined {
  if (source[start] !== "$") return;
  let cursor = start + 1;
  if (source[cursor] === "$") return "$$";
  if (!isIdentifierStart(source[cursor] ?? "")) return;
  cursor += 1;
  while (cursor < source.length && isIdentifierPart(source[cursor] ?? ""))
    cursor += 1;
  if (source[cursor] !== "$") return;
  return source.slice(start, cursor + 1);
}

function readQuoted(
  source: string,
  start: number,
  quote: string,
): { value: string; next: number } | undefined {
  let cursor = start + 1;
  let value = "";
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === undefined) {
      return;
    }
    if (character === quote) {
      const following = source[cursor + 1];
      if (following === quote) {
        value += quote;
        cursor += 2;
        continue;
      }
      return { value, next: cursor + 1 };
    }
    value += character;
    cursor += 1;
  }
  return undefined;
}

export function tokenizeSql(source: string): SqlTokenizationResult {
  const tokens: SqlToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === undefined) {
      break;
    }
    if (isSpace(character)) {
      cursor += 1;
      continue;
    }
    if (character === "-" && source[cursor + 1] === "-") {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (character === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2);
      if (end < 0) {
        return {
          ok: false,
          code: "TOKENIZATION_ERROR",
          message: "unterminated block comment",
          offset: cursor,
        };
      }
      cursor = end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quoted = readQuoted(source, cursor, character);
      if (quoted === undefined) {
        return {
          ok: false,
          code: "TOKENIZATION_ERROR",
          message: "unterminated quoted token",
          offset: cursor,
        };
      }
      tokens.push({
        kind: character === "'" ? "string" : "quoted-identifier",
        value: quoted.value,
        offset: cursor,
      });
      cursor = quoted.next;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarDelimiter(source, cursor);
      if (delimiter === undefined)
        return {
          ok: false,
          code: "TOKENIZATION_ERROR",
          message: "invalid dollar-quoted token",
          offset: cursor,
        };
      const contentStart = cursor + delimiter.length;
      const end = source.indexOf(delimiter, contentStart);
      if (end < 0)
        return {
          ok: false,
          code: "TOKENIZATION_ERROR",
          message: "unterminated dollar-quoted token",
          offset: cursor,
        };
      tokens.push({
        kind: "string",
        value: source.slice(contentStart, end),
        offset: cursor,
      });
      cursor = end + delimiter.length;
      continue;
    }
    if (PUNCTUATION.has(character)) {
      tokens.push({ kind: "punctuation", value: character, offset: cursor });
      cursor += 1;
      continue;
    }
    if (isDigit(character)) {
      const start = cursor;
      cursor += 1;
      while (
        cursor < source.length &&
        (isDigit(source[cursor] ?? "") || source[cursor] === ".")
      ) {
        cursor += 1;
      }
      tokens.push({
        kind: "number",
        value: source.slice(start, cursor),
        offset: start,
      });
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < source.length && isIdentifierPart(source[cursor] ?? "")) {
        cursor += 1;
      }
      const value = source.slice(start, cursor);
      tokens.push({
        kind: KEYWORDS.has(value.toUpperCase()) ? "keyword" : "identifier",
        value: value.toUpperCase(),
        offset: start,
      });
      continue;
    }
    return {
      ok: false,
      code: "TOKENIZATION_ERROR",
      message: `unsupported character ${character}`,
      offset: cursor,
    };
  }
  return { ok: true, tokens };
}
