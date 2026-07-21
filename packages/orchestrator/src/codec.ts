export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JSON_LIMITS = Object.freeze({
  bytes: 65_536,
  depth: 8,
  values: 4096,
});

class JsonParser {
  private index = 0;
  private values = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): JsonValue {
    this.space();
    const value = this.value(0);
    this.space();
    if (this.index !== this.source.length) throw new Error("trailing input");
    return value;
  }

  private value(depth: number): JsonValue {
    if (depth > JSON_LIMITS.depth) throw new Error("nesting limit");
    this.values += 1;
    if (this.values > JSON_LIMITS.values) throw new Error("value limit");
    const character = this.source[this.index];
    if (character === '"') return this.string();
    if (character === "{") return this.object(depth);
    if (character === "[") return this.array(depth);
    if (character === "t") return this.literal("true", true);
    if (character === "f") return this.literal("false", false);
    if (character === "n") return this.literal("null", null);
    return this.number();
  }

  private literal<T extends JsonValue>(text: string, value: T): T {
    if (this.source.slice(this.index, this.index + text.length) !== text) {
      throw new Error("invalid literal");
    }
    this.index += text.length;
    return value;
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        const parsed: unknown = JSON.parse(
          this.source.slice(start, this.index),
        );
        if (typeof parsed !== "string") throw new Error("invalid string");
        return parsed;
      }
      if (code < 0x20) throw new Error("control character");
      if (code === 0x5c) {
        this.index += 1;
        const escapeCode = this.source[this.index];
        if (escapeCode === "u") {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw new Error("unicode escape");
          this.index += 5;
          continue;
        }
        if (
          !['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escapeCode ?? "")
        ) {
          throw new Error("invalid escape");
        }
      }
      this.index += 1;
    }
    throw new Error("unterminated string");
  }

  private number(): number {
    const rest = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(rest);
    if (match === null) throw new Error("invalid value");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return value;
  }

  private array(depth: number): readonly JsonValue[] {
    this.index += 1;
    this.space();
    const values: JsonValue[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return values;
    }
    while (true) {
      values.push(this.value(depth + 1));
      this.space();
      const separator = this.source[this.index];
      this.index += 1;
      if (separator === "]") return values;
      if (separator !== ",") throw new Error("array separator");
      this.space();
    }
  }

  private object(depth: number): { readonly [key: string]: JsonValue } {
    this.index += 1;
    this.space();
    const entries: [string, JsonValue][] = [];
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return Object.fromEntries(entries);
    }
    while (true) {
      if (this.source[this.index] !== '"') throw new Error("object key");
      const key = this.string();
      if (keys.has(key)) throw new Error("duplicate key");
      keys.add(key);
      this.space();
      if (this.source[this.index] !== ":") throw new Error("object colon");
      this.index += 1;
      this.space();
      entries.push([key, this.value(depth + 1)]);
      this.space();
      const separator = this.source[this.index];
      this.index += 1;
      if (separator === "}") return Object.fromEntries(entries);
      if (separator !== ",") throw new Error("object separator");
      this.space();
    }
  }

  private space() {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\r" ||
      this.source[this.index] === "\n"
    ) {
      this.index += 1;
    }
  }
}

export function parseJsonBytes(value: unknown): JsonValue | undefined {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > JSON_LIMITS.bytes
  )
    return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    return new JsonParser(text).parse();
  } catch {
    return undefined;
  }
}

export interface RuntimeRecord {
  readonly [key: string]: unknown;
  readonly action?: unknown;
  readonly anchors?: unknown;
  readonly artifactValidators?: unknown;
  readonly artifacts?: unknown;
  readonly bytes?: unknown;
  readonly code?: unknown;
  readonly commandBytes?: unknown;
  readonly compiler?: unknown;
  readonly contentBytes?: unknown;
  readonly current?: unknown;
  readonly currentEvidenceBytes?: unknown;
  readonly descriptors?: unknown;
  readonly diagnosticInterceptor?: unknown;
  readonly diagnostics?: unknown;
  readonly dimension?: unknown;
  readonly direction?: unknown;
  readonly effect?: unknown;
  readonly effectClassificationAuthority?: unknown;
  readonly evidenceId?: unknown;
  readonly evidence?: unknown;
  readonly exitCode?: unknown;
  readonly graph?: unknown;
  readonly id?: unknown;
  readonly identifiers?: unknown;
  readonly intercept?: unknown;
  readonly invariants?: unknown;
  readonly kind?: unknown;
  readonly limit?: unknown;
  readonly limits?: unknown;
  readonly measure?: unknown;
  readonly measurementAuthority?: unknown;
  readonly measurements?: unknown;
  readonly negations?: unknown;
  readonly nonEffectSpawn?: unknown;
  readonly outputBytes?: unknown;
  readonly outputCaps?: unknown;
  readonly payloadBytes?: unknown;
  readonly payloadRef?: unknown;
  readonly policyId?: unknown;
  readonly precedence?: unknown;
  readonly presentation?: unknown;
  readonly previousId?: unknown;
  readonly proposal?: unknown;
  readonly proposalDigest?: unknown;
  readonly proposed?: unknown;
  readonly proposedEvidenceBytes?: unknown;
  readonly quotedText?: unknown;
  readonly rationale?: unknown;
  readonly rawRequest?: unknown;
  readonly rawDigest?: unknown;
  readonly repository?: unknown;
  readonly repositoryAuthority?: unknown;
  readonly repositoryId?: unknown;
  readonly request?: unknown;
  readonly requestDigest?: unknown;
  readonly requiredInvariants?: unknown;
  readonly reviewed?: unknown;
  readonly scope?: unknown;
  readonly securitySeverity?: unknown;
  readonly severity?: unknown;
  readonly snapshotBytes?: unknown;
  readonly source?: unknown;
  readonly spawn?: unknown;
  readonly state?: unknown;
  readonly structural?: unknown;
  readonly subject?: unknown;
  readonly summary?: unknown;
  readonly target?: unknown;
  readonly tests?: unknown;
  readonly tokens?: unknown;
  readonly treeBytes?: unknown;
  readonly treeDigest?: unknown;
  readonly contextDigest?: unknown;
  readonly unit?: unknown;
  readonly userCopy?: unknown;
  readonly valid?: unknown;
  readonly validate?: unknown;
  readonly classify?: unknown;
  readonly verificationAuthority?: unknown;
  readonly verifier?: unknown;
  readonly version?: unknown;
}

export function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export function bytesOf(value: unknown): readonly number[] | undefined {
  const values =
    value instanceof Uint8Array
      ? Array.from(value)
      : Array.isArray(value)
        ? value
        : undefined;
  if (
    values === undefined ||
    values.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    return undefined;
  }
  return Object.freeze([...values]);
}

export function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return Object.freeze([...value]);
}

export function nonempty(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\u0000") &&
    !value.includes("\r") &&
    !value.includes("\n")
  );
}
