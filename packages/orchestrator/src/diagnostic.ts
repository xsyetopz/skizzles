import { bytesOf, exactKeys, isRecord, nonempty } from "./codec.ts";
import { type Digest, digestBytes } from "./digest.ts";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface DiagnosticEvidence {
  readonly source: string;
  readonly bytes: readonly number[];
  readonly digest: Digest;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly summary: string;
  readonly evidence: readonly DiagnosticEvidence[];
}

export type DiagnosticResult =
  | { readonly status: "accepted"; readonly diagnostic: Diagnostic }
  | { readonly status: "rejected"; readonly code: "INVALID_DIAGNOSTIC" };

export interface DiagnosticInterceptor {
  intercept: (diagnostic: Diagnostic) => unknown | Promise<unknown>;
}

const abusive =
  /\b(?:idiot|lazy|stupid|moron|dumb|worthless|useless|pathetic|incompetent|trash|garbage|screw you|shut up|piece of trash)\b/iu;
const personalAddress = /\b(?:you|your|yours|yourself|yourselves)\b/iu;
const firstPerson =
  /(?:\b(?:we|us|our|ours|ourselves|me|my|mine|myself)\b)|(?:^|[\s(])i(?=$|[\s,.;:!?])/iu;
const firstPersonContraction = /\b(?:i|we)['’](?:m|ve|re|d|ll)\b/iu;
const codePattern = /^[A-Z][A-Z0-9_]{2,63}$/u;
const severities = new Set<string>(["error", "warning", "info"]);
const diagnostics = new WeakMap<object, Diagnostic>();

function isSeverity(value: unknown): value is DiagnosticSeverity {
  return typeof value === "string" && severities.has(value);
}

export function parseDiagnostic(input: unknown): DiagnosticResult {
  if (isRecord(input)) {
    const verified = diagnostics.get(input);
    if (verified !== undefined) {
      return { status: "accepted", diagnostic: verified };
    }
  }
  if (
    !(
      isRecord(input) &&
      exactKeys(input, ["code", "severity", "summary", "evidence"])
    ) ||
    typeof input.code !== "string" ||
    !codePattern.test(input.code) ||
    !isSeverity(input.severity) ||
    typeof input.summary !== "string" ||
    input.summary.length === 0 ||
    input.summary.length > 160 ||
    /[\r\n]/u.test(input.summary) ||
    abusive.test(input.summary) ||
    personalAddress.test(input.summary) ||
    firstPerson.test(input.summary) ||
    firstPersonContraction.test(input.summary) ||
    !Array.isArray(input.evidence) ||
    input.evidence.length === 0 ||
    input.evidence.length > 32
  ) {
    return { status: "rejected", code: "INVALID_DIAGNOSTIC" };
  }
  const evidence: DiagnosticEvidence[] = [];
  for (const item of input.evidence) {
    if (
      !(
        isRecord(item) &&
        exactKeys(item, ["source", "bytes"]) &&
        nonempty(item.source)
      )
    ) {
      return { status: "rejected", code: "INVALID_DIAGNOSTIC" };
    }
    const bytes = bytesOf(item.bytes);
    if (bytes === undefined || bytes.length === 0) {
      return { status: "rejected", code: "INVALID_DIAGNOSTIC" };
    }
    evidence.push(
      Object.freeze({
        source: item.source,
        bytes,
        digest: digestBytes(Uint8Array.from(bytes)),
      }),
    );
  }
  const diagnostic: Diagnostic = Object.freeze({
    code: input.code,
    severity: input.severity,
    summary: input.summary,
    evidence: Object.freeze(evidence),
  });
  diagnostics.set(diagnostic, diagnostic);
  return { status: "accepted", diagnostic };
}

export async function interceptDiagnostic(
  input: unknown,
  interceptor?: DiagnosticInterceptor,
): Promise<DiagnosticResult> {
  const parsed = parseDiagnostic(input);
  if (parsed.status === "rejected" || interceptor === undefined) {
    return parsed;
  }
  try {
    const intercepted = parseDiagnostic(
      await interceptor.intercept(parsed.diagnostic),
    );
    if (
      intercepted.status === "rejected" ||
      !sameDiagnosticInvariant(parsed.diagnostic, intercepted.diagnostic)
    ) {
      return { status: "rejected", code: "INVALID_DIAGNOSTIC" };
    }
    return intercepted;
  } catch {
    return { status: "rejected", code: "INVALID_DIAGNOSTIC" };
  }
}

export function recoverDiagnosticBytes(value: unknown): Uint8Array | undefined {
  try {
    if (
      !isRecord(value) ||
      typeof value.source !== "string" ||
      !Array.isArray(value.bytes)
    ) {
      return;
    }
    const bytes = bytesOf(value.bytes);
    return bytes === undefined ? undefined : Uint8Array.from(bytes);
  } catch {
    return;
  }
}

function sameDiagnosticInvariant(left: Diagnostic, right: Diagnostic): boolean {
  return (
    left.code === right.code &&
    left.severity === right.severity &&
    left.evidence.length === right.evidence.length &&
    left.evidence.every((evidence, index) => {
      const candidate = right.evidence[index];
      return (
        candidate !== undefined &&
        evidence.source === candidate.source &&
        evidence.digest === candidate.digest &&
        evidence.bytes.length === candidate.bytes.length &&
        evidence.bytes.every(
          (byte, byteIndex) => byte === candidate.bytes[byteIndex],
        )
      );
    })
  );
}
