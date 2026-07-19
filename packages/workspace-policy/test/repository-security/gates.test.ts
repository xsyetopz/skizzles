// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { create } from "@skizzles/run-workspace";
import { runGitleaksGate } from "../../src/repository-security/gitleaks/gate.ts";
import {
  buildGitleaksArguments,
  classifyGitleaksResult,
  type GitleaksRawResult,
  type GitleaksScanner,
} from "../../src/repository-security/gitleaks/report.ts";
import {
  assertOwnedProcessScopesSupported,
  runBoundedCommand,
} from "../../src/repository-security/process.ts";
import { signalOwnedSupervisor } from "../../src/repository-security/process-supervisor.ts";
import { createSecurityFixtureScope } from "./support.ts";

const fixtures = createSecurityFixtureScope();
// Captured from pinned Gitleaks 8.30.1 using deterministic non-credential probes.
const GITLEAKS_8_30_1_CLEAN_STDERR =
  "7:00PM INF scanned ~1 bytes (1 bytes) in 1ms\n7:00PM INF no leaks found\n";
const GITLEAKS_8_30_1_FINDINGS_STDERR =
  "7:00PM INF scanned ~1 bytes (1 bytes) in 1ms\n7:00PM WRN leaks found: 1\n";

afterEach(fixtures.cleanup);

describe("repository security process and output contracts", () => {
  it("maps handled signals to shell statuses after deleting the run root", async () => {
    if (process.platform === "win32") {
      return;
    }
    for (const [signal, status] of [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const source = [
        'import { create } from "@skizzles/run-workspace";',
        'import { main } from "./src/security-cli.ts";',
        "const status = await main([], async () => {",
        "  const workspace = await create({ handleSignals: true, gracefulStopMs: 20, forceStopMs: 20 });",
        "  const interrupted = Promise.withResolvers();",
        "  workspace.signal.addEventListener('abort', interrupted.resolve, { once: true });",
        "  if (workspace.signal.aborted) interrupted.resolve();",
        "  console.log(workspace.path());",
        "  await interrupted.promise;",
        "  const reason = workspace.signal.reason;",
        "  const report = await workspace.close();",
        "  if (report.state !== 'deleted') throw new Error('cleanup failed');",
        "  throw reason;",
        "});",
        "process.exit(status);",
      ].join("\n");
      const child = Bun.spawn([process.execPath, "-e", source], {
        cwd: new URL("../..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      });
      const first = await child.stdout.getReader().read();
      const root = new TextDecoder().decode(first.value).trim();
      process.kill(child.pid, signal);
      expect(await child.exited).toBe(status);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("fails closed on Windows before a tool can be spawned", () => {
    let spawned = false;
    expect(() => {
      assertOwnedProcessScopesSupported("win32");
      spawned = true;
    }).toThrow("Windows Job Object support is unavailable");
    expect(spawned).toBeFalse();
  });

  it("confines every command temp variable to the owning run root", async () => {
    const outside = await create();
    const workspace = await create();
    const ambient = outside.path("ambient-temp");
    const sentinel = outside.path("ambient-temp", "sentinel");
    await mkdir(ambient, { recursive: true, mode: 0o700 });
    await writeFile(sentinel, "keep\n");
    try {
      const source = [
        'import { writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        "await writeFile(join(process.env.TMPDIR, 'tool-temp'), 'owned\\n');",
        "console.log(JSON.stringify({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, retained: process.env.RETAINED_KEY }));",
      ].join("\n");
      const result = await runBoundedCommand(
        workspace,
        process.execPath,
        ["--eval", source],
        {
          label: "temp confinement probe",
          env: {
            ...process.env,
            TMPDIR: ambient,
            TMP: ambient,
            TEMP: ambient,
            RETAINED_KEY: "retained",
          },
        },
      );
      const observed = JSON.parse(result.stdout) as Record<string, string>;
      expect(observed["TMPDIR"]).toBe(observed["TMP"]);
      expect(observed["TMPDIR"]).toBe(observed["TEMP"]);
      expect(observed["TMPDIR"]?.startsWith(`${workspace.path()}/`)).toBeTrue();
      expect(observed["retained"]).toBe("retained");
      expect(
        await readFile(join(observed["TMPDIR"] ?? "", "tool-temp"), "utf8"),
      ).toBe("owned\n");
      expect((await workspace.close()).state).toBe("deleted");
      await expect(lstat(observed["TMPDIR"] ?? "")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(sentinel, "utf8")).toBe("keep\n");
    } finally {
      await workspace.close();
      await outside.close();
    }
  });

  it("never signals a recyclable process group after its leader exits", () => {
    let signals = 0;
    const signalled = signalOwnedSupervisor(true, 42, "SIGKILL", (() => {
      signals += 1;
      return true;
    }) as typeof process.kill);
    expect(signalled).toBeFalse();
    expect(signals).toBe(0);
  });

  it("pins the Git history platform without changing directory scans", () => {
    const common = {
      executable: "/tmp/gitleaks",
      config: "/workspace/.gitleaks.toml",
      root: "/workspace",
      reportRoot: "/reports",
    } as const;

    expect(
      buildGitleaksArguments(
        { ...common, mode: "git", logOptions: ["--all"] },
        "/reports/findings.json",
      ),
    ).toEqual([
      "git",
      "--no-banner",
      "--redact=100",
      "--exit-code=10",
      "--report-format=json",
      "--report-path",
      "/reports/findings.json",
      "--config",
      "/workspace/.gitleaks.toml",
      "--platform=github",
      "--log-opts=--all",
      "/workspace",
    ]);
    expect(
      buildGitleaksArguments(
        { ...common, mode: "dir" },
        "/reports/findings.json",
      ),
    ).toEqual([
      "dir",
      "--no-banner",
      "--redact=100",
      "--exit-code=10",
      "--report-format=json",
      "--report-path",
      "/reports/findings.json",
      "--config",
      "/workspace/.gitleaks.toml",
      "/workspace",
    ]);
  });

  it("bounds command output and execution time", async () => {
    await expect(
      runBoundedCommand(await fixtures.workspace(), "yes", ["probe"], {
        label: "output probe",
        outputLimitBytes: 128,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("128-byte output limit");

    await expect(
      runBoundedCommand(
        await fixtures.workspace(),
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

  it("kills a TERM-resistant descendant holding both output pipes on timeout", async () => {
    const workspace = await fixtures.workspace();
    const record = workspace.path("timeout-descendant.json");
    const source = descendantToolSource(record, false);
    const started = Date.now();
    await expect(
      runBoundedCommand(workspace, process.execPath, ["--eval", source], {
        label: "descendant timeout probe",
        timeoutMs: 150,
      }),
    ).rejects.toThrow("150ms timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    const identity = JSON.parse(await readFile(record, "utf8")) as {
      descendant: number;
      pgid: number;
      supervisor: number;
    };
    expect(identity.pgid).toBe(identity.supervisor);
    expect(processExists(identity.descendant)).toBeFalse();
  });

  it("cleans a successful tool's lingering descendant before returning", async () => {
    const workspace = await fixtures.workspace();
    const record = workspace.path("success-descendant.json");
    const result = await runBoundedCommand(
      workspace,
      process.execPath,
      ["--eval", descendantToolSource(record, true)],
      { label: "successful descendant probe", timeoutMs: 2000 },
    );
    const identity = JSON.parse(await readFile(record, "utf8")) as {
      descendant: number;
      pgid: number;
      supervisor: number;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("descendant stdout");
    expect(result.stderr).toContain("descendant stderr");
    expect(identity.pgid).toBe(identity.supervisor);
    expect(processExists(identity.descendant)).toBeFalse();
  });

  it("fails and retains the root when the supervisor exits before its group", async () => {
    const workspace = await create({ gracefulStopMs: 20, forceStopMs: 20 });
    const root = workspace.path();
    const record = workspace.path("orphaned-tool.pid");
    const source = [
      'import { writeFile } from "node:fs/promises";',
      'import process from "node:process";',
      `await writeFile(${JSON.stringify(record)}, String(process.pid));`,
      'process.kill(process.ppid, "SIGKILL");',
      "await Bun.sleep(10000);",
    ].join("\n");
    await expect(
      runBoundedCommand(workspace, process.execPath, ["--eval", source], {
        label: "exited supervisor probe",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("supervisor lifecycle failed");
    expect(await lstat(root)).toBeDefined();
    const toolPid = Number(await readFile(record, "utf8"));
    if (processExists(toolPid)) {
      process.kill(toolPid, "SIGKILL");
      await waitForProcessExit(toolPid);
    }
    expect((await workspace.close()).state).toBe("deleted");
  }, 10_000);

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
      runGitleaksGate(
        await fixtures.workspace(),
        root,
        probeRoot,
        "/tmp/fake-gitleaks",
        scanner,
      ),
    ).rejects.toThrow("operational failure: exited with status 2");
    expect(index).toBe(3);
  });
});

function descendantToolSource(record: string, succeed: boolean): string {
  return [
    'import { writeFile } from "node:fs/promises";',
    'import process from "node:process";',
    "const descendant = Bun.spawn([process.execPath, '--eval', `process.on('SIGTERM', () => undefined); console.log('descendant stdout'); console.error('descendant stderr'); setInterval(() => undefined, 1000);`], { stdout: 'inherit', stderr: 'inherit' });",
    "const pgidText = await new Response(Bun.spawn(['/bin/ps', '-o', 'pgid=', '-p', String(process.pid)], { stdout: 'pipe' }).stdout).text();",
    `await writeFile(${JSON.stringify(record)}, JSON.stringify({ descendant: descendant.pid, pgid: Number(pgidText.trim()), supervisor: process.ppid }));`,
    "await Bun.sleep(75);",
    succeed
      ? "process.exit(0);"
      : "process.on('SIGTERM', () => undefined); await Bun.sleep(10000);",
  ].join("\n");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (processExists(pid) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  if (processExists(pid)) {
    throw new Error(`process ${pid} did not exit`);
  }
}

async function temporaryRoot(): Promise<string> {
  return await fixtures.directory("gates");
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
    const result = await runBoundedCommand(
      await fixtures.workspace(),
      "/usr/bin/git",
      args,
      {
        cwd: root,
        label: "security test Git setup",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error("security test Git setup failed");
    }
  }
  await writeFile(join(root, "seed.txt"), "seed\n", { mode: 0o600 });
  for (const args of [
    ["add", "seed.txt"],
    ["commit", "--quiet", "-m", "seed"],
  ]) {
    const result = await runBoundedCommand(
      await fixtures.workspace(),
      "/usr/bin/git",
      args,
      {
        cwd: root,
        label: "security test Git commit",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error("security test Git commit failed");
    }
  }
}
