import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPOSITORY_TOOL_ENV, runBoundedCommand } from "./bounded-process.ts";

const GITLEAKS_TIMEOUT_MS = 120_000;
const GITLEAKS_OUTPUT_LIMIT_BYTES = 1_048_576;
const PRIVATE_DIRECTORY_MODE = 0o700;
const TOKEN_PART_LENGTH = 20;
const TOKEN_ALPHABET_SIZE = 62;
const TOKEN_STEP = 17;
const DIGIT_COUNT = 10;
const ALPHANUMERIC_UPPER_COUNT = 36;
const DIGIT_CODE_POINT = 48;
const UPPER_CODE_POINT_OFFSET = 55;
const LOWER_CODE_POINT_OFFSET = 61;
const GIT_EXECUTABLE = "/usr/bin/git";

interface GitleaksInvocation {
  executable: string;
  mode: "dir" | "git";
  config: string;
  root: string;
  logOptions?: readonly string[];
}

async function runGitleaksGate(
  workspaceRoot: string,
  probeRoot: string,
  gitleaks: string,
): Promise<void> {
  const config = join(workspaceRoot, ".gitleaks.toml");
  await requireCompleteHistory(workspaceRoot);
  expectClean(
    await invokeGitleaks({
      executable: gitleaks,
      mode: "dir",
      config,
      root: workspaceRoot,
    }),
    "repository tree",
  );
  expectClean(
    await invokeGitleaks({
      executable: gitleaks,
      mode: "git",
      config,
      root: workspaceRoot,
      logOptions: ["--all"],
    }),
    "repository history",
  );
  await runGitleaksCausalProbes(probeRoot, gitleaks, config);
}

async function runGitleaksCausalProbes(
  probeRoot: string,
  gitleaks: string,
  config: string,
): Promise<void> {
  const directoryProbe = join(probeRoot, "gitleaks-directory");
  await mkdir(directoryProbe, { recursive: true, mode: 0o700 });
  await chmod(directoryProbe, PRIVATE_DIRECTORY_MODE);
  const probeFile = join(directoryProbe, "evidence.txt");
  const providerToken = providerLikeToken();
  await writeFile(probeFile, `OPENAI_API_KEY=${providerToken}\n`, {
    mode: 0o600,
  });
  expectLeak(
    await invokeGitleaks({
      executable: gitleaks,
      mode: "dir",
      config,
      root: directoryProbe,
    }),
    providerToken,
    "provider-like token",
  );

  const allowedCanary = ["sk-privacy-canary-", "4f9e2d7c"].join("");
  await writeFile(probeFile, `${allowedCanary}\n`, { mode: 0o600 });
  expectClean(
    await invokeGitleaks({
      executable: gitleaks,
      mode: "dir",
      config,
      root: directoryProbe,
    }),
    "exact privacy canary",
  );

  const adjacentCanary = `${allowedCanary.slice(0, -1)}d`;
  await writeFile(probeFile, `${adjacentCanary}\n`, { mode: 0o600 });
  expectLeak(
    await invokeGitleaks({
      executable: gitleaks,
      mode: "dir",
      config,
      root: directoryProbe,
    }),
    adjacentCanary,
    "adjacent privacy token",
  );

  const historyProbe = join(probeRoot, "gitleaks-history");
  await mkdir(historyProbe, { recursive: true, mode: 0o700 });
  await chmod(historyProbe, PRIVATE_DIRECTORY_MODE);
  await git(historyProbe, ["init", "--quiet"]);
  await git(historyProbe, [
    "config",
    "user.email",
    "security-probe@example.invalid",
  ]);
  await git(historyProbe, ["config", "user.name", "Security Probe"]);
  const historyFile = join(historyProbe, "removed.txt");
  await writeFile(historyFile, `${providerToken}\n`, { mode: 0o600 });
  await git(historyProbe, ["add", "removed.txt"]);
  await git(historyProbe, ["commit", "--quiet", "-m", "add probe"]);
  await writeFile(historyFile, "removed\n", { mode: 0o600 });
  await git(historyProbe, ["add", "removed.txt"]);
  await git(historyProbe, ["commit", "--quiet", "-m", "remove probe"]);
  expectLeak(
    await invokeGitleaks({
      executable: gitleaks,
      mode: "git",
      config,
      root: historyProbe,
      logOptions: ["--all"],
    }),
    providerToken,
    "removed history token",
  );
}

function invokeGitleaks(
  invocation: GitleaksInvocation,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = [
    invocation.mode,
    "--no-banner",
    "--redact=100",
    "--config",
    invocation.config,
  ];
  for (const option of invocation.logOptions ?? []) {
    args.push(`--log-opts=${option}`);
  }
  args.push(invocation.root);
  return runBoundedCommand(invocation.executable, args, {
    label: `gitleaks ${invocation.mode}`,
    timeoutMs: GITLEAKS_TIMEOUT_MS,
    outputLimitBytes: GITLEAKS_OUTPUT_LIMIT_BYTES,
    env: REPOSITORY_TOOL_ENV,
  });
}

function expectClean(result: { exitCode: number }, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`gitleaks rejected the ${label}; findings are withheld`);
  }
}

function expectLeak(
  result: { exitCode: number; stdout: string; stderr: string },
  token: string,
  label: string,
): void {
  if (result.exitCode === 0) {
    throw new Error(`gitleaks did not reject the ${label} probe`);
  }
  if (result.stdout.includes(token) || result.stderr.includes(token)) {
    throw new Error(`gitleaks exposed the raw ${label} in captured output`);
  }
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
