import { digestValue } from "../../digest.ts";
import type { CredentialFinding } from "./contract.ts";

const SENSITIVE_NAMES = [
  "api_key",
  "apikey",
  "access_key",
  "client_secret",
  "private_key",
  "password",
  "passwd",
  "secret",
  "token",
  "auth",
];
const KNOWN_PREFIXES = ["sk-", "ghp_", "github_pat_", "AKIA", "xoxb-", "xoxp-"];
const MIN_TOKEN_LENGTH = 24;
const MIN_TOKEN_ENTROPY = 4.2;
const MIN_BINARY_ENTROPY = 7;

export function finding(
  code: CredentialFinding["code"],
  path: string,
  message: string,
  evidence: string,
): CredentialFinding {
  return { code, path, message, evidenceDigest: digestValue(evidence) };
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value)
    counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function tokenCharacter(character: string): boolean {
  return /[A-Za-z0-9_+/=:-]/u.test(character);
}

function secretLikeValue(value: string): boolean {
  const trimmed = value
    .trim()
    .replace(/^['"`]/u, "")
    .replace(/['"`,;)]$/u, "");
  if (
    trimmed.length < 8 ||
    trimmed.startsWith("${") ||
    trimmed.includes("example") ||
    trimmed.includes("CHANGE_ME")
  )
    return false;
  return (
    KNOWN_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ||
    entropy(trimmed) >= MIN_TOKEN_ENTROPY
  );
}

function sensitiveName(line: string): boolean {
  const lower = line.toLowerCase();
  return SENSITIVE_NAMES.some((name) => lower.includes(name));
}

export function scanText(path: string, text: string): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const normalized = line.trim();
    if (
      normalized.startsWith("-----BEGIN") &&
      normalized.includes("PRIVATE KEY-----")
    )
      findings.push(
        finding(
          "CREDENTIAL_STRUCTURE",
          path,
          "private-key material is not publishable",
          normalized.slice(0, 32),
        ),
      );
    const separator =
      normalized.indexOf("=") >= 0
        ? normalized.indexOf("=")
        : normalized.indexOf(":");
    if (separator >= 0 && sensitiveName(normalized)) {
      const value = normalized.slice(separator + 1).trim();
      if (secretLikeValue(value))
        findings.push(
          finding(
            "CREDENTIAL_STRUCTURE",
            path,
            "credential-shaped assignment is not publishable",
            value,
          ),
        );
    }
  }
  let cursor = 0;
  while (cursor < text.length) {
    while (cursor < text.length && !tokenCharacter(text[cursor] ?? ""))
      cursor += 1;
    const start = cursor;
    while (cursor < text.length && tokenCharacter(text[cursor] ?? ""))
      cursor += 1;
    const token = text.slice(start, cursor);
    if (token.length >= MIN_TOKEN_LENGTH && entropy(token) >= MIN_TOKEN_ENTROPY)
      findings.push(
        finding(
          "HIGH_ENTROPY_SECRET",
          path,
          "high-entropy credential-shaped token is not publishable",
          token,
        ),
      );
  }
  return findings;
}

export function scanBinary(
  path: string,
  bytes: Uint8Array,
): CredentialFinding[] {
  if (bytes.length < MIN_TOKEN_LENGTH) return [];
  const counts = new Uint32Array(256);
  for (const byte of bytes) counts[byte] = (counts[byte] ?? 0) + 1;
  let value = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / bytes.length;
    value -= probability * Math.log2(probability);
  }
  if (value < MIN_BINARY_ENTROPY) return [];
  return [
    finding(
      "HIGH_ENTROPY_SECRET",
      path,
      "high-entropy binary candidate is not publishable without an explicit binary authority",
      `${bytes.length}:${value.toFixed(4)}`,
    ),
  ];
}
