import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunWorkspace } from "@skizzles/run-workspace";
import { REPOSITORY_TOOL_ENV, runBoundedCommand } from "../process.ts";
import {
  classifyGitleaksResult,
  type GitleaksRawResult,
  type GitleaksScanner,
  invokeGitleaks,
} from "./report.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UNREADABLE_FILE_MODE = 0o000;
const TOKEN_PART_LENGTH = 20;
const TOKEN_ALPHABET_SIZE = 62;
const TOKEN_STEP = 17;
const DIGIT_COUNT = 10;
const ALPHANUMERIC_UPPER_COUNT = 36;
const DIGIT_CODE_POINT = 48;
const UPPER_CODE_POINT_OFFSET = 55;
const LOWER_CODE_POINT_OFFSET = 61;
const GIT_EXECUTABLE = "/usr/bin/git";
const UNREADABLE_WARNING_PATTERN = /\bWRN skipping file: permission denied\b/iu;

interface GitleaksGateContext {
  readonly workspace: RunWorkspace;
  readonly probeRoot: string;
  readonly reportRoot: string;
  readonly gitleaks: string;
  readonly config: string;
  readonly scanner: GitleaksScanner;
}

interface GitleaksScanTarget {
  readonly mode: "dir" | "git";
  readonly root: string;
  readonly logOptions?: readonly string[];
}

async function runGitleaksGate(
  runWorkspace: RunWorkspace,
  workspaceRoot: string,
  probeRoot: string,
  gitleaks: string,
  scanner: GitleaksScanner = invokeGitleaks,
): Promise<void> {
  const config = join(workspaceRoot, ".gitleaks.toml");
  const reportRoot = join(probeRoot, "reports");
  await mkdir(reportRoot, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(reportRoot, PRIVATE_DIRECTORY_MODE);
  const context: GitleaksGateContext = {
    workspace: runWorkspace,
    probeRoot,
    reportRoot,
    gitleaks,
    config,
    scanner,
  };
  await requireCompleteHistory(runWorkspace, workspaceRoot);
  expectClean(
    await scan(context, { mode: "dir", root: workspaceRoot }),
    "repository tree",
  );
  expectClean(
    await scan(context, {
      mode: "git",
      root: workspaceRoot,
      logOptions: ["--all"],
    }),
    "repository history",
  );
  await runGitleaksCausalProbes(context);
}

async function runGitleaksCausalProbes(
  context: GitleaksGateContext,
): Promise<void> {
  const { probeRoot } = context;
  const directoryProbe = join(probeRoot, "gitleaks-directory");
  await mkdir(directoryProbe, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  await chmod(directoryProbe, PRIVATE_DIRECTORY_MODE);
  const probeFile = join(directoryProbe, "evidence.txt");
  const providerToken = providerLikeToken();
  await writeFile(probeFile, `OPENAI_API_KEY=${providerToken}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  expectLeak(
    await scan(context, { mode: "dir", root: directoryProbe }),
    providerToken,
    "provider-like token",
  );

  const genericToken = `${generatedTokenPart(7)}${generatedTokenPart(19)}`;
  await writeFile(probeFile, `api_key = '${genericToken}'\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  expectLeak(
    await scan(context, { mode: "dir", root: directoryProbe }),
    genericToken,
    "generic assignment token",
  );

  const allowedCanary = ["sk-privacy-canary-", "4f9e2d7c"].join("");
  await writeFile(probeFile, `${allowedCanary}\n`, { mode: PRIVATE_FILE_MODE });
  expectClean(
    await scan(context, { mode: "dir", root: directoryProbe }),
    "exact privacy canary",
  );

  const adjacentCanary = `${allowedCanary.slice(0, -1)}d`;
  await writeFile(probeFile, `${adjacentCanary}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  expectLeak(
    await scan(context, { mode: "dir", root: directoryProbe }),
    adjacentCanary,
    "adjacent privacy token",
  );

  const historyProbe = join(probeRoot, "gitleaks-history");
  await mkdir(historyProbe, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(historyProbe, PRIVATE_DIRECTORY_MODE);
  await git(context.workspace, historyProbe, ["init", "--quiet"]);
  await git(context.workspace, historyProbe, [
    "config",
    "user.email",
    "security-probe@example.invalid",
  ]);
  await git(context.workspace, historyProbe, [
    "config",
    "user.name",
    "Security Probe",
  ]);
  const historyFile = join(historyProbe, "removed.txt");
  await writeFile(historyFile, `${providerToken}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  await git(context.workspace, historyProbe, ["add", "removed.txt"]);
  await git(context.workspace, historyProbe, [
    "commit",
    "--quiet",
    "-m",
    "add probe",
  ]);
  await writeFile(historyFile, "removed\n", { mode: PRIVATE_FILE_MODE });
  await git(context.workspace, historyProbe, ["add", "removed.txt"]);
  await git(context.workspace, historyProbe, [
    "commit",
    "--quiet",
    "-m",
    "remove probe",
  ]);
  expectLeak(
    await scan(context, {
      mode: "git",
      root: historyProbe,
      logOptions: ["--all"],
    }),
    providerToken,
    "removed history token",
  );
  await verifyUnreadableFileFailure(context);
}

function scan(
  context: GitleaksGateContext,
  target: GitleaksScanTarget,
): Promise<GitleaksRawResult> {
  return context.scanner(
    {
      executable: context.gitleaks,
      config: context.config,
      reportRoot: context.reportRoot,
      ...target,
    },
    context.workspace,
  );
}

function expectClean(result: GitleaksRawResult, label: string): void {
  const outcome = classifyGitleaksResult(result, label);
  if (outcome.kind !== "clean") {
    throw new Error(
      `gitleaks detected findings in the ${label}; details withheld`,
    );
  }
}

function expectLeak(
  result: GitleaksRawResult,
  token: string,
  label: string,
): void {
  if (
    result.stdout.includes(token) ||
    result.stderr.includes(token) ||
    result.report.includes(token)
  ) {
    throw new Error(`gitleaks exposed the raw ${label} in captured output`);
  }
  const outcome = classifyGitleaksResult(result, `${label} probe`);
  if (outcome.kind !== "findings") {
    throw new Error(`gitleaks did not reject the ${label} probe`);
  }
}

async function verifyUnreadableFileFailure(
  context: GitleaksGateContext,
): Promise<void> {
  const root = join(context.probeRoot, "gitleaks-unreadable");
  await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(root, PRIVATE_DIRECTORY_MODE);
  const unreadable = join(root, "unreadable.txt");
  await writeFile(unreadable, "non-secret probe\n", {
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(unreadable, UNREADABLE_FILE_MODE);
  let result: GitleaksRawResult;
  try {
    result = await scan(context, { mode: "dir", root });
  } finally {
    await chmod(unreadable, PRIVATE_FILE_MODE);
  }
  if (!UNREADABLE_WARNING_PATTERN.test(result.stderr)) {
    throw new Error(
      "gitleaks unreadable-file probe did not emit a skip warning",
    );
  }
  try {
    classifyGitleaksResult(result, "unreadable-file probe");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("operational failure")
    ) {
      return;
    }
    throw error;
  }
  throw new Error("gitleaks accepted an unreadable-file skip as a clean scan");
}

async function git(
  runWorkspace: RunWorkspace,
  root: string,
  args: readonly string[],
): Promise<void> {
  const result = await runBoundedCommand(runWorkspace, GIT_EXECUTABLE, args, {
    cwd: root,
    label: "gitleaks history probe Git setup",
    timeoutMs: 10_000,
    outputLimitBytes: 65_536,
    env: REPOSITORY_TOOL_ENV,
  });
  if (result.exitCode !== 0) {
    throw new Error("gitleaks history probe Git setup failed");
  }
}

async function requireCompleteHistory(
  runWorkspace: RunWorkspace,
  root: string,
): Promise<void> {
  const result = await runBoundedCommand(
    runWorkspace,
    GIT_EXECUTABLE,
    ["rev-parse", "--is-shallow-repository"],
    {
      cwd: root,
      label: "Gitleaks history preflight",
      timeoutMs: 10_000,
      outputLimitBytes: 1024,
      env: REPOSITORY_TOOL_ENV,
    },
  );
  if (result.exitCode !== 0 || result.stdout.trim() !== "false") {
    throw new Error("gitleaks requires a non-shallow repository history");
  }
}

function providerLikeToken(): string {
  return `sk-${generatedTokenPart(7)}${["T3B", "lbk", "FJ"].join("")}${generatedTokenPart(19)}`;
}

function generatedTokenPart(seed: number): string {
  return Array.from({ length: TOKEN_PART_LENGTH }, (_, index) => {
    const offset = (seed + index * TOKEN_STEP) % TOKEN_ALPHABET_SIZE;
    if (offset < DIGIT_COUNT) {
      return String.fromCharCode(DIGIT_CODE_POINT + offset);
    }
    if (offset < ALPHANUMERIC_UPPER_COUNT) {
      return String.fromCharCode(UPPER_CODE_POINT_OFFSET + offset);
    }
    return String.fromCharCode(LOWER_CODE_POINT_OFFSET + offset);
  }).join("");
}

export { requireCompleteHistory, runGitleaksGate };
