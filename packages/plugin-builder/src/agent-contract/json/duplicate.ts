const MAX_JSON_DEPTH = 128;
const MAX_JSON_VALUES = 100_000;

export class DuplicateJsonKeyError extends Error {}

export function assertNoDuplicateJsonKeys(text: string): void {
  new JsonLexicalValidator(text).validate();
}

class JsonLexicalValidator {
  readonly #text: string;
  #index = 0;
  #values = 0;

  constructor(text: string) {
    this.#text = text;
  }

  validate(): void {
    this.#whitespace();
    this.#value(0);
    this.#whitespace();
    if (this.#index !== this.#text.length) {
      throw new SyntaxError("Unexpected trailing JSON content.");
    }
  }

  #value(depth: number): void {
    this.#values += 1;
    if (depth > MAX_JSON_DEPTH || this.#values > MAX_JSON_VALUES) {
      throw new SyntaxError("JSON structure exceeds lexical bounds.");
    }
    const token = this.#text[this.#index];
    if (token === "{") {
      this.#object(depth + 1);
      return;
    }
    if (token === "[") {
      this.#array(depth + 1);
      return;
    }
    if (token === '"') {
      this.#string();
      return;
    }
    if (token === "t") {
      this.#literal("true");
      return;
    }
    if (token === "f") {
      this.#literal("false");
      return;
    }
    if (token === "n") {
      this.#literal("null");
      return;
    }
    this.#number();
  }

  #object(depth: number): void {
    this.#index += 1;
    this.#whitespace();
    const keys = new Set<string>();
    if (this.#consume("}")) {
      return;
    }
    while (true) {
      if (this.#text[this.#index] !== '"') {
        throw new SyntaxError("JSON object key must be a string.");
      }
      const key = this.#string();
      if (keys.has(key)) {
        throw new DuplicateJsonKeyError("Duplicate decoded JSON key.");
      }
      keys.add(key);
      this.#whitespace();
      this.#expect(":");
      this.#whitespace();
      this.#value(depth);
      this.#whitespace();
      if (this.#consume("}")) {
        return;
      }
      this.#expect(",");
      this.#whitespace();
    }
  }

  #array(depth: number): void {
    this.#index += 1;
    this.#whitespace();
    if (this.#consume("]")) {
      return;
    }
    while (true) {
      this.#value(depth);
      this.#whitespace();
      if (this.#consume("]")) {
        return;
      }
      this.#expect(",");
      this.#whitespace();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#expect('"');
    while (this.#index < this.#text.length) {
      const code = this.#text.charCodeAt(this.#index);
      if (code === 0x22) {
        this.#index += 1;
        const token = this.#text.slice(start, this.#index);
        return JSON.parse(token) as string;
      }
      if (code < 0x20) {
        throw new SyntaxError("Control character in JSON string.");
      }
      if (code === 0x5c) {
        this.#index += 1;
        const escapeCode = this.#text[this.#index];
        if (escapeCode === "u") {
          const digits = this.#text.slice(this.#index + 1, this.#index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) {
            throw new SyntaxError("Invalid JSON Unicode escape.");
          }
          this.#index += 5;
          continue;
        }
        if (escapeCode === undefined || !'"\\/bfnrt'.includes(escapeCode)) {
          throw new SyntaxError("Invalid JSON escape.");
        }
      }
      this.#index += 1;
    }
    throw new SyntaxError("Unterminated JSON string.");
  }

  #number(): void {
    const rest = this.#text.slice(this.#index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(rest);
    if (match === null) {
      throw new SyntaxError("Invalid JSON value.");
    }
    this.#index += match[0].length;
  }

  #literal(literal: string): void {
    if (!this.#text.startsWith(literal, this.#index)) {
      throw new SyntaxError("Invalid JSON literal.");
    }
    this.#index += literal.length;
  }

  #whitespace(): void {
    while (
      this.#text[this.#index] === " " ||
      this.#text[this.#index] === "\n" ||
      this.#text[this.#index] === "\r" ||
      this.#text[this.#index] === "\t"
    ) {
      this.#index += 1;
    }
  }

  #expect(token: string): void {
    if (!this.#consume(token)) {
      throw new SyntaxError(`Expected JSON token ${token}.`);
    }
  }

  #consume(token: string): boolean {
    if (this.#text[this.#index] !== token) {
      return false;
    }
    this.#index += 1;
    return true;
  }
}
