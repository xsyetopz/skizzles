import { digestBytes, digestValue } from "../../digest.ts";
import { finding, scanBinary, scanText } from "./content.ts";
import type {
  CredentialFinding,
  SecretScanInput,
  SecretScanner,
  SecretScanReceipt,
  SecretScanResult,
} from "./contract.ts";
import {
  authorizedFor,
  envPath,
  parseScanInput,
  pathIsUnsafe,
} from "./input.ts";

const AUTHENTIC_SCANNERS = new WeakSet<object>();
const DEFAULT_CONFIGURATION_PATHS = [
  "config/production.json",
  "config/production.yaml",
  "config/production.yml",
];

function scanInput(input: SecretScanInput): SecretScanResult {
  const findings: CredentialFinding[] = [];
  const paths = input.candidates.map((candidate) => candidate.path);
  const configurationPaths = new Set([
    ...DEFAULT_CONFIGURATION_PATHS,
    ...(input.configurationPaths ?? []),
  ]);
  const candidateDigest = digestValue(
    input.candidates.map((candidate) => ({
      path: candidate.path,
      bytes: digestBytes(candidate.bytes),
    })),
  );
  for (const candidate of input.candidates) {
    if (pathIsUnsafe(candidate.path)) {
      findings.push(
        finding(
          "FORBIDDEN_CONFIG_PATH",
          candidate.path,
          "candidate path is not a safe relative path",
          candidate.path,
        ),
      );
      continue;
    }
    const isConfig = configurationPaths.has(candidate.path);
    const isAuthorized = authorizedFor(
      candidate.path,
      candidate.bytes,
      input.authorizedConfigurationWrites ?? [],
    );
    if (envPath(candidate.path) && !isAuthorized) {
      findings.push(
        finding(
          "FORBIDDEN_ENV_PATH",
          candidate.path,
          ".env files require the structured configuration registry",
          candidate.path,
        ),
      );
      continue;
    }
    if (isConfig && !isAuthorized) {
      findings.push(
        finding(
          "FORBIDDEN_CONFIG_PATH",
          candidate.path,
          "configured files require an exact registry receipt",
          candidate.path,
        ),
      );
      continue;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        candidate.bytes,
      );
      findings.push(...scanText(candidate.path, text));
    } catch {
      findings.push(...scanBinary(candidate.path, candidate.bytes));
    }
  }
  const material = {
    accepted: findings.length === 0,
    candidateDigest,
    findings,
    scannedPaths: paths,
  };
  const receipt: SecretScanReceipt = Object.freeze({
    ...material,
    findings: Object.freeze([...findings]),
    scannedPaths: Object.freeze([...paths]),
    receiptDigest: digestValue(material),
  });
  return receipt.accepted ? { ok: true, receipt } : { ok: false, receipt };
}

function malformedReceipt(): SecretScanReceipt {
  const findingValue = finding(
    "FORBIDDEN_CONFIG_PATH",
    "<input>",
    "candidate bytes are malformed",
    "invalid",
  );
  const material = {
    accepted: false,
    candidateDigest: digestValue("invalid"),
    findings: [findingValue],
    scannedPaths: [] as const,
  };
  return Object.freeze({
    ...material,
    findings: Object.freeze(material.findings),
    scannedPaths: Object.freeze([]),
    receiptDigest: digestValue(material),
  });
}

export function createSecretScanner(): SecretScanner {
  const scanner: SecretScanner = Object.freeze({
    scan: (input: SecretScanInput) => {
      try {
        const parsed = parseScanInput(input);
        if (parsed === undefined)
          return { ok: false, receipt: malformedReceipt() };
        return scanInput(parsed);
      } catch {
        return { ok: false, receipt: malformedReceipt() };
      }
    },
  });
  AUTHENTIC_SCANNERS.add(scanner);
  return scanner;
}

export function isSecretScanner(value: unknown): value is SecretScanner {
  return (
    typeof value === "object" && value !== null && AUTHENTIC_SCANNERS.has(value)
  );
}

export function scanCandidateSecrets(input: SecretScanInput): SecretScanResult {
  return createSecretScanner().scan(input);
}
