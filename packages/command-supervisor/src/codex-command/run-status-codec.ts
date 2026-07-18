import { parseRunLifecycle } from "./run-lifecycle-codec.ts";
import {
  type EvidenceReference,
  operatorActionLabel,
  type RunStatus,
  runStatusSchema,
  runStatusVersion,
} from "./run-status.ts";

export const maximumStatusBytes = 64 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    expected.every((key, index) => key === actual[index])
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseEvidence(
  value: unknown,
  reference: EvidenceReference["reference"],
  maximumBytes: number,
): EvidenceReference | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "integrity",
      "observedBytes",
      "redaction",
      "reference",
      "sensitivity",
      "sha256",
      "storedBytes",
      "truncated",
    ])
  ) {
    return undefined;
  }
  const observedBytes = value["observedBytes"];
  const storedBytes = value["storedBytes"];
  const truncated = value["truncated"];
  const digest = value["sha256"];
  const valid =
    value["reference"] === reference &&
    value["sensitivity"] === "operator-private" &&
    value["redaction"] === "none" &&
    value["integrity"] === "unauthenticated-sha256" &&
    isSafeInteger(observedBytes) &&
    isSafeInteger(storedBytes) &&
    storedBytes <= observedBytes &&
    storedBytes <= maximumBytes &&
    typeof truncated === "boolean" &&
    (observedBytes === storedBytes || truncated) &&
    typeof digest === "string" &&
    sha256Pattern.test(digest);
  if (!valid || typeof digest !== "string") {
    return undefined;
  }
  return {
    reference,
    sensitivity: "operator-private",
    redaction: "none",
    integrity: "unauthenticated-sha256",
    observedBytes,
    storedBytes,
    truncated,
    sha256: digest,
  };
}

export function parseRunStatus(content: string, id: string): RunStatus {
  if (Buffer.byteLength(content) > maximumStatusBytes) {
    throw new Error("status exceeds its schema bound");
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("status is not valid JSON");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "action",
      "artifactCapture",
      "evidence",
      "execution",
      "id",
      "lifecycle",
      "retention",
      "schema",
      "version",
    ]) ||
    value["schema"] !== runStatusSchema ||
    value["version"] !== runStatusVersion ||
    value["id"] !== id ||
    value["artifactCapture"] !== "active"
  ) {
    throw new Error("status schema is unsupported");
  }
  const action = value["action"];
  const execution = value["execution"];
  const retention = value["retention"];
  const evidence = value["evidence"];
  if (
    !isRecord(action) ||
    !hasExactKeys(action, ["label", "redaction", "sensitivity", "sha256"]) ||
    action["label"] !== operatorActionLabel ||
    action["sensitivity"] !== "secret-bearing" ||
    action["redaction"] !== "content-omitted" ||
    typeof action["sha256"] !== "string" ||
    !sha256Pattern.test(action["sha256"]) ||
    !isRecord(execution) ||
    !hasExactKeys(execution, ["shell"]) ||
    typeof execution["shell"] !== "string" ||
    !execution["shell"].startsWith("/") ||
    execution["shell"].length > 4_096 ||
    !isRecord(retention) ||
    !hasExactKeys(retention, [
      "cleanupThresholdBytes",
      "directoryMode",
      "fileMode",
      "maximumOutputArtifactBytes",
      "policy",
    ]) ||
    retention["policy"] !== "per-output-cap-with-pre-run-completed-cleanup" ||
    retention["directoryMode"] !== "0700" ||
    retention["fileMode"] !== "0600" ||
    !isSafeInteger(retention["maximumOutputArtifactBytes"]) ||
    retention["maximumOutputArtifactBytes"] < 1 ||
    !isSafeInteger(retention["cleanupThresholdBytes"]) ||
    retention["cleanupThresholdBytes"] <
      retention["maximumOutputArtifactBytes"] ||
    !isRecord(evidence) ||
    !hasExactKeys(evidence, ["stderr", "stdout"])
  ) {
    throw new Error("status schema is malformed");
  }
  const stdout = parseEvidence(
    evidence["stdout"],
    "stdout.log",
    retention["maximumOutputArtifactBytes"],
  );
  const stderr = parseEvidence(
    evidence["stderr"],
    "stderr.log",
    retention["maximumOutputArtifactBytes"],
  );
  const lifecycle = parseRunLifecycle(value["lifecycle"]);
  if (!(stdout && stderr && lifecycle)) {
    throw new Error("status schema is malformed");
  }
  return {
    schema: runStatusSchema,
    version: runStatusVersion,
    id,
    action: {
      label: operatorActionLabel,
      sha256: action["sha256"],
      sensitivity: "secret-bearing",
      redaction: "content-omitted",
    },
    execution: { shell: execution["shell"] },
    retention: {
      policy: "per-output-cap-with-pre-run-completed-cleanup",
      maximumOutputArtifactBytes: retention["maximumOutputArtifactBytes"],
      cleanupThresholdBytes: retention["cleanupThresholdBytes"],
      directoryMode: "0700",
      fileMode: "0600",
    },
    evidence: { stdout, stderr },
    lifecycle,
    artifactCapture: "active",
  };
}

export function serializeRunStatus(status: RunStatus): string {
  const content = `${JSON.stringify(status)}\n`;
  if (status.artifactCapture === "active") {
    parseRunStatus(content, status.id);
  }
  return content;
}
