import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { REPOSITORY_TOOL_ENV, runBoundedCommand } from "./bounded-process.ts";

const FINDINGS_EXIT_CODE = 10;
const GITLEAKS_TIMEOUT_MS = 120_000;
const MAXIMUM_REPORT_BYTES = 1_048_576;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_FILE_CREATION_MASK = 0o077;
const FINDINGS_WARNING_PATTERN = /\bWRN leaks found: (\d+)\s*$/u;
const OPERATIONAL_DIAGNOSTIC_PATTERN =
  /\b(?:ERR|FTL|PNC)\b|skipp(?:ed|ing)|permission denied|failed|unable|could not/iu;

const FINDING_KEYS = [
  "Author",
  "Commit",
  "Date",
  "Description",
  "Email",
  "EndColumn",
  "EndLine",
  "Entropy",
  "File",
  "Fingerprint",
  "Match",
  "Message",
  "RuleID",
  "Secret",
  "StartColumn",
  "StartLine",
  "SymlinkFile",
  "Tags",
] as const;

interface GitleaksInvocation {
  executable: string;
  mode: "dir" | "git";
  config: string;
  root: string;
  reportRoot: string;
  logOptions?: readonly string[];
}

interface GitleaksRawResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  report: string;
}

interface GitleaksOutcome {
  kind: "clean" | "findings";
  findings: number;
}

type GitleaksScanner = (
  invocation: GitleaksInvocation,
) => Promise<GitleaksRawResult>;

async function invokeGitleaks(
  invocation: GitleaksInvocation,
): Promise<GitleaksRawResult> {
  const reportDirectory = await mkdtemp(join(invocation.reportRoot, "scan-"));
  const reportPath = join(reportDirectory, "findings.json");
  try {
    await chmod(reportDirectory, PRIVATE_DIRECTORY_MODE);
    await writeFile(reportPath, "", { flag: "wx", mode: PRIVATE_FILE_MODE });
    await chmod(reportPath, PRIVATE_FILE_MODE);
    const args = [
      invocation.mode,
      "--no-banner",
      "--redact=100",
      `--exit-code=${FINDINGS_EXIT_CODE}`,
      "--report-format=json",
      "--report-path",
      reportPath,
      "--config",
      invocation.config,
    ];
    for (const option of invocation.logOptions ?? []) {
      args.push(`--log-opts=${option}`);
    }
    args.push(invocation.root);
    const result = await runBoundedCommand(invocation.executable, args, {
      label: `gitleaks ${invocation.mode}`,
      timeoutMs: GITLEAKS_TIMEOUT_MS,
      outputLimitBytes: MAXIMUM_REPORT_BYTES,
      env: REPOSITORY_TOOL_ENV,
      fileCreationMask: PRIVATE_FILE_CREATION_MASK,
    });
    const metadata = await lstat(reportPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw new Error("gitleaks report is not one owner-only regular file");
    }
    if (metadata.size > MAXIMUM_REPORT_BYTES) {
      throw new Error("gitleaks report exceeded its byte limit");
    }
    return { ...result, report: await readFile(reportPath, "utf8") };
  } finally {
    await rm(reportDirectory, { force: true, recursive: true });
  }
}

function classifyGitleaksResult(
  result: GitleaksRawResult,
  label: string,
): GitleaksOutcome {
  if (result.stdout !== "") {
    throw operational(label, "wrote unexpected stdout");
  }
  if (result.exitCode === 0) {
    validateCleanDiagnostics(result.stderr, label);
    if (result.report.trim() !== "[]") {
      throw operational(
        label,
        "clean status did not produce an exact empty report",
      );
    }
    return { kind: "clean", findings: 0 };
  }
  if (result.exitCode !== FINDINGS_EXIT_CODE) {
    throw operational(label, `exited with status ${result.exitCode}`);
  }
  const findings = parseRedactedFindings(result.report, label);
  if (findings === 0) {
    throw operational(label, "findings status produced an empty report");
  }
  validateFindingsDiagnostics(result.stderr, findings, label);
  return { kind: "findings", findings };
}

function validateCleanDiagnostics(stderr: string, label: string): void {
  const lines = diagnosticLines(stderr);
  if (
    lines.some(
      (line) =>
        /\b(?:WRN|ERR|FTL|PNC)\b/u.test(line) ||
        OPERATIONAL_DIAGNOSTIC_PATTERN.test(line),
    ) ||
    !lines.some((line) => line.includes(" INF no leaks found"))
  ) {
    throw operational(
      label,
      "clean status contained warning, skipped, or error diagnostics",
    );
  }
}

function validateFindingsDiagnostics(
  stderr: string,
  findings: number,
  label: string,
): void {
  const lines = diagnosticLines(stderr);
  if (lines.some((line) => OPERATIONAL_DIAGNOSTIC_PATTERN.test(line))) {
    throw operational(
      label,
      "findings status contained operational diagnostics",
    );
  }
  const warnings = lines.filter((line) => /\bWRN\b/u.test(line));
  if (warnings.length !== 1) {
    throw operational(
      label,
      "findings status did not contain one findings warning",
    );
  }
  const match = FINDINGS_WARNING_PATTERN.exec(warnings[0] ?? "");
  if (match === null || Number(match[1]) !== findings) {
    throw operational(
      label,
      "findings warning did not match the redacted report",
    );
  }
}

function parseRedactedFindings(report: string, label: string): number {
  let input: unknown;
  try {
    input = JSON.parse(report);
  } catch (error) {
    throw new Error(`gitleaks ${label} report was not JSON`, { cause: error });
  }
  if (!Array.isArray(input)) {
    throw operational(label, "report must be a JSON array");
  }
  for (const finding of input) {
    validateRedactedFinding(finding, label);
  }
  return input.length;
}

function validateRedactedFinding(input: unknown, label: string): void {
  if (!isRecord(input)) {
    throw operational(label, "report finding must be an object");
  }
  const keys = Object.keys(input).sort();
  const expected = [...FINDING_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw operational(label, "report finding keys changed");
  }
  for (const key of [
    "Author",
    "Commit",
    "Date",
    "Description",
    "Email",
    "File",
    "Fingerprint",
    "Match",
    "Message",
    "RuleID",
    "Secret",
    "SymlinkFile",
  ] as const) {
    if (typeof input[key] !== "string") {
      throw operational(label, `report finding ${key} must be a string`);
    }
  }
  for (const key of [
    "EndColumn",
    "EndLine",
    "Entropy",
    "StartColumn",
    "StartLine",
  ] as const) {
    if (typeof input[key] !== "number" || !Number.isFinite(input[key])) {
      throw operational(label, `report finding ${key} must be a finite number`);
    }
  }
  if (
    input["Match"] !== "REDACTED" ||
    input["Secret"] !== "REDACTED" ||
    input["RuleID"] === "" ||
    input["File"] === "" ||
    input["Fingerprint"] === "" ||
    !Array.isArray(input["Tags"]) ||
    input["Tags"].some((tag) => typeof tag !== "string")
  ) {
    throw operational(label, "report finding was not fully redacted and typed");
  }
}

function diagnosticLines(stderr: string): string[] {
  return stderr.split(/\r?\n/u).filter((line) => line !== "");
}

function operational(label: string, reason: string): Error {
  return new Error(`gitleaks ${label} operational failure: ${reason}`);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export type {
  GitleaksInvocation,
  GitleaksOutcome,
  GitleaksRawResult,
  GitleaksScanner,
};
export { classifyGitleaksResult, invokeGitleaks };
