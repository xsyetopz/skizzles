// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runBoundedCommand } from "../src/repository-security/bounded-process.ts";
import { runGitleaksGate } from "../src/repository-security/gitleaks-gate.ts";
import {
  classifyGitleaksResult,
  type GitleaksRawResult,
  type GitleaksScanner,
} from "../src/repository-security/gitleaks-report.ts";

const temporaryRoots: string[] = [];
// Captured from pinned Gitleaks 8.30.1 using deterministic non-credential probes.
const GITLEAKS_8_30_1_CLEAN_STDERR =
  "7:00PM INF scanned ~1 bytes (1 bytes) in 1ms\n7:00PM INF no leaks found\n";
const GITLEAKS_8_30_1_FINDINGS_STDERR =
  "7:00PM INF scanned ~1 bytes (1 bytes) in 1ms\n7:00PM WRN leaks found: 1\n";

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("repository security process and output contracts", () => {
  it("bounds command output and execution time", async () => {
    await expect(
      runBoundedCommand("yes", ["probe"], {
        label: "output probe",
        outputLimitBytes: 128,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("128-byte output limit");

    await expect(
      runBoundedCommand(
        process.execPath,
        ["--eval", "await Bun.sleep(10000)"],
        {
          label: "timeout probe",
          outputLimitBytes: 128,
          timeoutMs: 25,
        },
      ),
    ).rejects.toThrow("25ms timeout");
  });

  it("distinguishes clean, findings, warnings, and operational failures", () => {
    expect(classifyGitleaksResult(cleanGitleaksResult(), "clean")).toEqual({
      kind: "clean",
      findings: 0,
    });
    expect(
      classifyGitleaksResult(findingsGitleaksResult(), "findings"),
    ).toEqual({ kind: "findings", findings: 1 });

    expect(() =>
      classifyGitleaksResult(
        { ...cleanGitleaksResult(), exitCode: 2 },
        "error",
      ),
    ).toThrow("operational failure: exited with status 2");
    expect(() =>
      classifyGitleaksResult(
        {
          ...cleanGitleaksResult(),
          stderr:
            "7:00PM INF scanned ~1 bytes (1 bytes) in 1ms\n7:00PM WRN skipping file: permission denied path=/private/probe\n7:00PM INF no leaks found\n",
        },
        "skip",
      ),
    ).toThrow("unknown line");
    expect(() =>
      classifyGitleaksResult(
        {
          ...cleanGitleaksResult(),
          stderr:
            "7:00PM INF scanned ~1 bytes (1 bytes) in 1ms\n7:00PM WARN arbitrary warning\n7:00PM INF no leaks found\n",
        },
        "unknown warning",
      ),
    ).toThrow("unknown line");
    expect(() =>
      classifyGitleaksResult(
        { ...cleanGitleaksResult(), report: redactedFindingReport() },
        "ambiguous clean",
      ),
    ).toThrow("exact empty report");
    expect(() =>
      classifyGitleaksResult(
        { ...findingsGitleaksResult(), report: "[]\n" },
        "ambiguous findings",
      ),
    ).toThrow("empty report");
    expect(() =>
      classifyGitleaksResult(
        {
          ...findingsGitleaksResult(),
          report: redactedFindingReport(
            `api_key = 'REDACTED' ${"A".repeat(32)}`,
          ),
        },
        "retained token-like context",
      ),
    ).toThrow("not fully redacted");
  });

  it("rejects the former stateful operational-error sequence", async () => {
    const root = await temporaryRoot();
    await initializeGitRepository(root);
    const probeRoot = join(root, "probes");
    await mkdir(probeRoot, { mode: 0o700 });
    const statuses = [0, 0, 2, 0, 2, 2] as const;
    let index = 0;
    const scanner: GitleaksScanner = async () => {
      const status = statuses[index] ?? 2;
      index += 1;
      if (status === 0) {
        return cleanGitleaksResult();
      }
      return {
        exitCode: status,
        stdout: "",
        stderr: "7:00PM ERR probe operational failure\n",
        report: "[]\n",
      };
    };

    await expect(
      runGitleaksGate(root, probeRoot, "/tmp/fake-gitleaks", scanner),
    ).rejects.toThrow("operational failure: exited with status 2");
    expect(index).toBe(3);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-security-test-"));
  temporaryRoots.push(root);
  return root;
}

function cleanGitleaksResult(): GitleaksRawResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: GITLEAKS_8_30_1_CLEAN_STDERR,
    report: "[]\n",
  };
}

function findingsGitleaksResult(): GitleaksRawResult {
  return {
    exitCode: 10,
    stdout: "",
    stderr: GITLEAKS_8_30_1_FINDINGS_STDERR,
    report: redactedFindingReport(),
  };
}

function redactedFindingReport(match = "api_key = 'REDACTED'"): string {
  return `${JSON.stringify([
    {
      RuleID: "probe-rule",
      Description: "probe",
      StartLine: 1,
      EndLine: 1,
      StartColumn: 1,
      EndColumn: 2,
      Match: match,
      Secret: "REDACTED",
      File: "/private/probe",
      SymlinkFile: "",
      Commit: "",
      Entropy: 4,
      Author: "",
      Email: "",
      Date: "",
      Message: "",
      Tags: [],
      Fingerprint: "/private/probe:probe-rule:1",
    },
  ])}\n`;
}

async function initializeGitRepository(root: string): Promise<void> {
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "security-test@example.invalid"],
    ["config", "user.name", "Security Test"],
  ]) {
    const result = await runBoundedCommand("/usr/bin/git", args, {
      cwd: root,
      label: "security test Git setup",
    });
    if (result.exitCode !== 0) {
      throw new Error("security test Git setup failed");
    }
  }
  await writeFile(join(root, "seed.txt"), "seed\n", { mode: 0o600 });
  for (const args of [
    ["add", "seed.txt"],
    ["commit", "--quiet", "-m", "seed"],
  ]) {
    const result = await runBoundedCommand("/usr/bin/git", args, {
      cwd: root,
      label: "security test Git commit",
    });
    if (result.exitCode !== 0) {
      throw new Error("security test Git commit failed");
    }
  }
}
