import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPOSITORY_TOOL_ENV, runBoundedCommand } from "./bounded-process.ts";
import {
  classifyGitleaksResult,
  type GitleaksRawResult,
  type GitleaksScanner,
  invokeGitleaks,
} from "./gitleaks-report.ts";

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

async function runGitleaksGate(
  workspaceRoot: string,
  probeRoot: string,
  gitleaks: string,
  scanner: GitleaksScanner = invokeGitleaks,
): Promise<void> {
  const config = join(workspaceRoot, ".gitleaks.toml");
  const reportRoot = join(probeRoot, "reports");
  await mkdir(reportRoot, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(reportRoot, PRIVATE_DIRECTORY_MODE);
  await requireCompleteHistory(workspaceRoot);
  expectClean(
    await scanner({
      executable: gitleaks,
      mode: "dir",
      config,
      root: workspaceRoot,
      reportRoot,
    }),
    "repository tree",
  );
  expectClean(
    await scanner({
      executable: gitleaks,
      mode: "git",
      config,
      root: workspaceRoot,
      reportRoot,
      logOptions: ["--all"],
    }),
    "repository history",
  );
  await runGitleaksCausalProbes(
    probeRoot,
    reportRoot,
    gitleaks,
    config,
    scanner,
  );
  if ((await readdir(reportRoot)).length > 0) {
    throw new Error("gitleaks retained an ephemeral report artifact");
  }
}

async function runGitleaksCausalProbes(
  probeRoot: string,
  reportRoot: string,
  gitleaks: string,
  config: string,
  scanner: GitleaksScanner,
): Promise<void> {
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
    await scanner({
      executable: gitleaks,
      mode: "dir",
      config,
      root: directoryProbe,
      reportRoot,
    }),
    providerToken,
    "provider-like token",
  );

  const allowedCanary = ["sk-privacy-canary-", "4f9e2d7c"].join("");
  await writeFile(probeFile, `${allowedCanary}\n`, { mode: PRIVATE_FILE_MODE });
  expectClean(
    await scanner({
      executable: gitleaks,
      mode: "dir",
      config,
      root: directoryProbe,
      reportRoot,
    }),
    "exact privacy canary",
  );

  const adjacentCanary = `${allowedCanary.slice(0, -1)}d`;
  await writeFile(probeFile, `${adjacentCanary}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  expectLeak(
    await scanner({
      executable: gitleaks,
      mode: "dir",
      config,
      root: directoryProbe,
      reportRoot,
    }),
    adjacentCanary,
    "adjacent privacy token",
  );

  const historyProbe = join(probeRoot, "gitleaks-history");
  await mkdir(historyProbe, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(historyProbe, PRIVATE_DIRECTORY_MODE);
  await git(historyProbe, ["init", "--quiet"]);
  await git(historyProbe, [
    "config",
    "user.email",
    "security-probe@example.invalid",
  ]);
  await git(historyProbe, ["config", "user.name", "Security Probe"]);
  const historyFile = join(historyProbe, "removed.txt");
  await writeFile(historyFile, `${providerToken}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  await git(historyProbe, ["add", "removed.txt"]);
  await git(historyProbe, ["commit", "--quiet", "-m", "add probe"]);
  await writeFile(historyFile, "removed\n", { mode: PRIVATE_FILE_MODE });
  await git(historyProbe, ["add", "removed.txt"]);
  await git(historyProbe, ["commit", "--quiet", "-m", "remove probe"]);
  expectLeak(
    await scanner({
      executable: gitleaks,
      mode: "git",
      config,
      root: historyProbe,
      reportRoot,
      logOptions: ["--all"],
    }),
    providerToken,
    "removed history token",
  );
  await verifyUnreadableFileFailure(
    probeRoot,
    reportRoot,
    gitleaks,
    config,
    scanner,
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
  probeRoot: string,
  reportRoot: string,
  gitleaks: string,
  config: string,
  scanner: GitleaksScanner,
): Promise<void> {
  const root = join(probeRoot, "gitleaks-unreadable");
  await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(root, PRIVATE_DIRECTORY_MODE);
  const unreadable = join(root, "unreadable.txt");
  await writeFile(unreadable, "non-secret probe\n", {
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(unreadable, UNREADABLE_FILE_MODE);
  let result: GitleaksRawResult;
  try {
    result = await scanner({
      executable: gitleaks,
      mode: "dir",
      config,
      root,
      reportRoot,
    });
  } finally {
    await chmod(unreadable, PRIVATE_FILE_MODE);
  }
  if (!/\bWRN skipping file: permission denied\b/iu.test(result.stderr)) {
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

async function git(root: string, args: readonly string[]): Promise<void> {
  const result = await runBoundedCommand(GIT_EXECUTABLE, args, {
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

async function requireCompleteHistory(root: string): Promise<void> {
  const result = await runBoundedCommand(
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
