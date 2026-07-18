// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const canonicalLauncher = join(
  repositoryRoot,
  "skills/codex-container-lab/scripts/codex-container-lab",
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Container Lab bundled launcher", () => {
  test("forwards attached argv, stdin, exit status, and termination signals", async () => {
    const normal = fixtureTarget(
      "const stdin = await Bun.stdin.text(); console.log(JSON.stringify({ args: process.argv.slice(2), stdin })); process.exit(Number(process.env.FAKE_EXIT ?? 0));",
    );
    const result = await invoke(
      normal,
      ["run", "--lab", "demo", "--", "printf", "hello"],
      "payload\n",
      { FAKE_EXIT: "23" },
    );
    expect(result.exitCode).toBe(23);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["run", "--lab", "demo", "--", "printf", "hello"],
      stdin: "payload\n",
    });

    const waiting = fixtureTarget(
      "process.on('SIGTERM', () => { console.log('terminated'); process.exit(143); }); const ready = process.env.FIXTURE_READY_PATH; if (!ready) throw new Error('FIXTURE_READY_PATH is required'); await Bun.write(ready, 'ready'); setInterval(() => {}, 1_000);",
    );
    const readinessPath = join(dirname(waiting), "fixture-ready");
    const child = Bun.spawn(["bun", waiting], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FIXTURE_READY_PATH: readinessPath },
    });
    child.stdin.end();
    await waitForArtifact(readinessPath, child.exited);
    child.kill("SIGTERM");
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(143);
    expect(stdout).toContain("terminated");
    expect(stderr).toBe("");
  });

  test("rejects readiness when the inner fixture exits before signaling", async () => {
    const failing = fixtureTarget("process.exit(17);");
    const readinessPath = join(dirname(failing), "fixture-ready");
    const child = Bun.spawn(["bun", failing], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, FIXTURE_READY_PATH: readinessPath },
    });

    await expect(waitForArtifact(readinessPath, child.exited)).rejects.toThrow(
      "launcher exited before fixture readiness: 17",
    );
    expect(await child.exited).toBe(17);
  });

  test("resolves the canonical and copied-plugin runtime without node_modules", async () => {
    const source = await invoke(canonicalLauncher, ["--help"]);
    expect(source.exitCode).toBe(0);
    expect(typeof (JSON.parse(source.stdout) as { help?: unknown }).help).toBe(
      "string",
    );

    const root = temporaryRoot();
    const plugin = join(root, "skizzles");
    cpSync(join(repositoryRoot, "plugins/skizzles"), plugin, {
      recursive: true,
    });
    expect(existsSync(join(plugin, "node_modules"))).toBe(false);
    const staged = await invoke(
      join(plugin, "skills/codex-container-lab/scripts/codex-container-lab"),
      ["--help"],
    );
    expect(staged.exitCode).toBe(0);
    expect(typeof (JSON.parse(staged.stdout) as { help?: unknown }).help).toBe(
      "string",
    );
  });

  test("uses a distinct PATH binary from a skill-only install without recursing", async () => {
    const root = temporaryRoot();
    const launcher = skillOnlyLauncher(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(launcher, join(bin, "codex-container-lab"));
    const fallback = join(root, "fallback", "codex-container-lab");
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(
      fallback,
      `#!${process.execPath}\nconsole.log(JSON.stringify({ fallback: true, args: process.argv.slice(2) }));\n`,
    );
    chmodSync(fallback, 0o755);

    const result = await invoke(
      launcher,
      ["run", "--lab", "demo", "--", "echo", "hello"],
      undefined,
      {
        PATH: `${bin}:${dirname(fallback)}:${process.env["PATH"] ?? ""}`,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      fallback: true,
      args: ["run", "--lab", "demo", "--", "echo", "hello"],
    });
    expect(result.stderr).toBe("");
  });

  test("explains the missing runtime for a skill-only install", async () => {
    const root = temporaryRoot();
    const launcher = skillOnlyLauncher(root);
    const result = await invoke(launcher, ["health"], undefined, {
      PATH: join(root, "empty"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("skill-only install contains guidance");
    expect(result.stderr).toContain("full Skizzles plugin");
    expect(result.stderr).not.toContain("module");
  });
});

function fixtureTarget(body: string): string {
  const root = temporaryRoot();
  const launcher = join(
    root,
    "skills/codex-container-lab/scripts/codex-container-lab",
  );
  const target = join(root, "packages/container-lab/src/cli.ts");
  mkdirSync(dirname(launcher), { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(launcher, readFileSync(canonicalLauncher));
  chmodSync(launcher, 0o755);
  writeFileSync(target, `#!/usr/bin/env bun\n${body}\n`);
  chmodSync(target, 0o755);
  return launcher;
}

function skillOnlyLauncher(root: string): string {
  const launcher = join(
    root,
    "skills/codex-container-lab/scripts/codex-container-lab",
  );
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, readFileSync(canonicalLauncher));
  chmodSync(launcher, 0o755);
  return launcher;
}

async function invoke(
  path: string,
  args: string[],
  stdin?: string,
  environment: Record<string, string> = {},
) {
  const child = Bun.spawn([process.execPath, path, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  if (stdin) {
    child.stdin.write(stdin);
  }
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skizzles-container-lab-launcher-"));
  temporaryRoots.push(root);
  return root;
}

function waitForArtifact(path: string, exited: Promise<number>): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let observer: ReturnType<typeof watch> | undefined;
    const settle = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      observer?.close();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    try {
      observer = watch(dirname(path), () => {
        if (existsSync(path)) {
          settle();
        }
      });
      observer.on("error", settle);
    } catch (error) {
      settle(error);
      return;
    }
    exited.then((exitCode) => {
      if (existsSync(path)) {
        settle();
      } else {
        settle(
          new Error(`launcher exited before fixture readiness: ${exitCode}`),
        );
      }
    }, settle);
    if (existsSync(path)) {
      settle();
    }
  });
}
