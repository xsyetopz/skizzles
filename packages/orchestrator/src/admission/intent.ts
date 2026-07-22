import {
  exactKeys,
  isRecord,
  JSON_LIMITS,
  parseJsonBytes,
  stringArray,
} from "../codec.ts";
import { type Digest, digestBytes, digestValue } from "../digest.ts";

export type SecuritySeverity = "none" | "low" | "medium" | "high" | "critical";

export interface CanonicalIntent {
  readonly action: string;
  readonly subject: string;
  readonly semanticDescriptors: readonly string[];
  readonly negations: readonly string[];
  readonly identifiers: readonly string[];
  readonly quotedText: readonly string[];
  readonly scope: readonly string[];
  readonly securitySeverity: SecuritySeverity;
  readonly userCopy: string;
}

export interface NormalizedRequest {
  readonly version: 1;
  readonly rawBytes: readonly number[];
  readonly rawDigest: Digest;
  readonly intentDigest: Digest;
  readonly source: {
    readonly action: string;
    readonly subject: string;
    readonly descriptors: readonly string[];
    readonly negations: readonly string[];
    readonly identifiers: readonly string[];
    readonly quotedText: readonly string[];
    readonly scope: readonly string[];
    readonly securitySeverity: SecuritySeverity;
    readonly userCopy: string;
  };
  readonly canonical: CanonicalIntent;
}

export type IntentResult =
  | { readonly status: "accepted"; readonly request: NormalizedRequest }
  | { readonly status: "rejected"; readonly code: "INVALID_REQUEST_ENVELOPE" };

const severities = new Set<string>([
  "none",
  "low",
  "medium",
  "high",
  "critical",
]);
const redundantStyle = new Set([
  "amazing",
  "awesome",
  "beautiful",
  "elegant",
  "nice",
  "please",
]);
const requests = new WeakSet<object>();

function isSeverity(value: unknown): value is SecuritySeverity {
  return typeof value === "string" && severities.has(value);
}

function canonicalWord(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

function canonicalWords(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [
      ...new Set(values.map(canonicalWord).filter((value) => value.length > 0)),
    ].sort(),
  );
}

function exactValues(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.filter((value) => value.length > 0))].sort(),
  );
}

function sourceValues(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

export function normalizeRequest(raw: unknown): IntentResult {
  if (
    !(raw instanceof Uint8Array) ||
    raw.byteLength === 0 ||
    raw.byteLength > JSON_LIMITS.bytes
  ) {
    return { status: "rejected", code: "INVALID_REQUEST_ENVELOPE" };
  }
  const bytes = Uint8Array.from(raw);
  const parsed = parseJsonBytes(bytes);
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, [
      "version",
      "action",
      "subject",
      "descriptors",
      "negations",
      "identifiers",
      "quotedText",
      "scope",
      "securitySeverity",
      "userCopy",
    ]) ||
    parsed.version !== 1 ||
    typeof parsed.action !== "string" ||
    typeof parsed.subject !== "string" ||
    typeof parsed.userCopy !== "string" ||
    !isSeverity(parsed.securitySeverity)
  ) {
    return { status: "rejected", code: "INVALID_REQUEST_ENVELOPE" };
  }
  const descriptors = stringArray(parsed.descriptors);
  const negations = stringArray(parsed.negations);
  const identifiers = stringArray(parsed.identifiers);
  const quotedText = stringArray(parsed.quotedText);
  const scope = stringArray(parsed.scope);
  const action = canonicalWord(parsed.action);
  const subject = canonicalWord(parsed.subject);
  if (
    descriptors === undefined ||
    negations === undefined ||
    identifiers === undefined ||
    quotedText === undefined ||
    scope === undefined ||
    action.length === 0 ||
    subject.length === 0 ||
    parsed.userCopy.length === 0 ||
    parsed.userCopy.length > 16_384 ||
    [descriptors, negations, identifiers, quotedText, scope].some(
      (values) =>
        values.length > 256 || values.some((value) => value.length > 4096),
    )
  ) {
    return { status: "rejected", code: "INVALID_REQUEST_ENVELOPE" };
  }

  const rawDigest = digestBytes(bytes);
  const source = Object.freeze({
    action: parsed.action,
    subject: parsed.subject,
    descriptors: sourceValues(descriptors),
    negations: sourceValues(negations),
    identifiers: sourceValues(identifiers),
    quotedText: sourceValues(quotedText),
    scope: sourceValues(scope),
    securitySeverity: parsed.securitySeverity,
    userCopy: parsed.userCopy,
  });
  const canonical: CanonicalIntent = Object.freeze({
    action,
    subject,
    semanticDescriptors: canonicalWords(
      descriptors.filter(
        (descriptor) => !redundantStyle.has(canonicalWord(descriptor)),
      ),
    ),
    negations: canonicalWords(negations),
    identifiers: exactValues(identifiers),
    quotedText: sourceValues(quotedText),
    scope: exactValues(scope),
    securitySeverity: parsed.securitySeverity,
    userCopy: parsed.userCopy,
  });
  const intentDigest = digestValue({ rawDigest, source, canonical });
  const request: NormalizedRequest = Object.freeze({
    version: 1,
    rawBytes: Object.freeze(Array.from(bytes)),
    rawDigest,
    intentDigest,
    source,
    canonical,
  });
  requests.add(request);
  return { status: "accepted", request };
}

export function isNormalizedRequest(
  value: unknown,
): value is NormalizedRequest {
  return isRecord(value) && requests.has(value);
}

export function recoverRequestBytes(value: unknown): Uint8Array | undefined {
  return isNormalizedRequest(value)
    ? Uint8Array.from(value.rawBytes)
    : undefined;
}
