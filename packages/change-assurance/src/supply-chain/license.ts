import { digestValue } from "../digest.ts";
import type { LicensePolicyState } from "./authority-state.ts";
import type {
  LicenseEvidence,
  LicensePolicyAuthority,
  SupplyChainFailureCode,
} from "./contract.ts";

const policies = new WeakMap<object, LicensePolicyState>();

export type LicenseEvaluationResult =
  | Readonly<{
      readonly status: "accepted";
      readonly evidence: LicenseEvidence;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly code: Extract<SupplyChainFailureCode, "LICENSE_POLICY_REJECTED">;
    }>;

export function bindLicensePolicyState(
  authority: LicensePolicyAuthority,
  state: LicensePolicyState,
): void {
  policies.set(authority, state);
}

export function evaluateLicense(
  authority: LicensePolicyAuthority,
  rawExpression: unknown,
): LicenseEvaluationResult {
  const state = policies.get(authority);
  if (
    state === undefined ||
    typeof rawExpression !== "string" ||
    rawExpression.length === 0 ||
    rawExpression.length > 256
  ) {
    return Object.freeze({
      status: "rejected",
      code: "LICENSE_POLICY_REJECTED",
    });
  }
  const parsed = parseExpression(rawExpression);
  if (parsed === undefined || !isAllowed(parsed, state.allowedLicenseIds)) {
    return Object.freeze({
      status: "rejected",
      code: "LICENSE_POLICY_REJECTED",
    });
  }
  const normalizedExpression = printExpression(parsed);
  const licenseIds = Object.freeze(
    [...new Set(collectLicenseIds(parsed))].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
  const evidence = Object.freeze({
    rawExpression,
    normalizedExpression,
    licenseIds,
    licenseDigest: digestValue({
      policyId: state.policyId,
      rawExpression,
      normalizedExpression,
      licenseIds,
    }),
  });
  return Object.freeze({ status: "accepted", evidence });
}

interface LicenseNode {
  readonly kind: "id" | "and" | "or" | "with";
  readonly id?: string;
  readonly left?: LicenseNode;
  readonly right?: LicenseNode;
  readonly exception?: string;
}

function parseExpression(input: string): LicenseNode | undefined {
  const tokens = tokenize(input);
  if (tokens === undefined || tokens.length === 0) return;
  const parser = new Parser(tokens);
  const result = parser.parseOr();
  return result !== undefined && parser.atEnd() ? result : undefined;
}

function tokenize(input: string): readonly string[] | undefined {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index];
    if (character === undefined) return;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "(" || character === ")") {
      tokens.push(character);
      index += 1;
      continue;
    }
    const match = /^[A-Za-z0-9][A-Za-z0-9.+-]*/u.exec(input.slice(index));
    if (match === null) return;
    tokens.push(match[0]);
    index += match[0].length;
  }
  return Object.freeze(tokens);
}

class Parser {
  readonly #tokens: readonly string[];
  #index = 0;

  constructor(tokens: readonly string[]) {
    this.#tokens = tokens;
  }

  parseOr(): LicenseNode | undefined {
    let left = this.parseAnd();
    while (this.peek() === "OR") {
      this.#index += 1;
      const right = this.parseAnd();
      if (left === undefined || right === undefined) return;
      left = Object.freeze({ kind: "or", left, right });
    }
    return left;
  }

  parseAnd(): LicenseNode | undefined {
    let left = this.parseWith();
    while (this.peek() === "AND") {
      this.#index += 1;
      const right = this.parseWith();
      if (left === undefined || right === undefined) return;
      left = Object.freeze({ kind: "and", left, right });
    }
    return left;
  }

  parseWith(): LicenseNode | undefined {
    const left = this.parsePrimary();
    if (left === undefined || this.peek() !== "WITH") return left;
    this.#index += 1;
    const exception = this.next();
    if (!validIdentifier(exception)) return;
    return Object.freeze({ kind: "with", left, exception });
  }

  parsePrimary(): LicenseNode | undefined {
    const token = this.next();
    if (token === "(") {
      const inner = this.parseOr();
      return inner !== undefined && this.next() === ")" ? inner : undefined;
    }
    return validIdentifier(token) &&
      token !== "AND" &&
      token !== "OR" &&
      token !== "WITH"
      ? Object.freeze({ kind: "id", id: token })
      : undefined;
  }

  atEnd(): boolean {
    return this.#index === this.#tokens.length;
  }

  private peek(): string | undefined {
    return this.#tokens[this.#index];
  }

  private next(): string | undefined {
    const token = this.#tokens[this.#index];
    this.#index += 1;
    return token;
  }
}

function validIdentifier(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(value);
}

function isAllowed(node: LicenseNode, allowed: readonly string[]): boolean {
  switch (node.kind) {
    case "id":
      return node.id !== undefined && allowed.includes(node.id);
    case "with":
      return (
        node.left !== undefined &&
        node.exception !== undefined &&
        isAllowed(node.left, allowed) &&
        allowed.includes(node.exception)
      );
    case "and":
      return (
        node.left !== undefined &&
        node.right !== undefined &&
        isAllowed(node.left, allowed) &&
        isAllowed(node.right, allowed)
      );
    case "or":
      return (
        node.left !== undefined &&
        node.right !== undefined &&
        (isAllowed(node.left, allowed) || isAllowed(node.right, allowed))
      );
  }
}

function collectLicenseIds(node: LicenseNode): readonly string[] {
  switch (node.kind) {
    case "id":
      return node.id === undefined ? [] : [node.id];
    case "with":
      return [
        ...(node.left === undefined ? [] : collectLicenseIds(node.left)),
        ...(node.exception === undefined ? [] : [node.exception]),
      ];
    case "and":
    case "or":
      return [
        ...(node.left === undefined ? [] : collectLicenseIds(node.left)),
        ...(node.right === undefined ? [] : collectLicenseIds(node.right)),
      ];
  }
}

function printExpression(node: LicenseNode): string {
  switch (node.kind) {
    case "id":
      return node.id ?? "";
    case "with":
      return `${printExpression(node.left ?? Object.freeze({ kind: "id", id: "" }))} WITH ${node.exception ?? ""}`;
    case "and":
      return `(${printExpression(node.left ?? Object.freeze({ kind: "id", id: "" }))} AND ${printExpression(node.right ?? Object.freeze({ kind: "id", id: "" }))})`;
    case "or":
      return `(${printExpression(node.left ?? Object.freeze({ kind: "id", id: "" }))} OR ${printExpression(node.right ?? Object.freeze({ kind: "id", id: "" }))})`;
  }
}
