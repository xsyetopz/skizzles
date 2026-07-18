// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const roots: string[] = [];
const entrypoint = resolve(import.meta.dir, "../src/index.ts");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = join(
    realpathSync(process.env["TMPDIR"] ?? "/tmp"),
    `skizzles-catalog-cli-${crypto.randomUUID()}`,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

async function run(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([process.execPath, entrypoint, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function renderArgs(root: string): string[] {
  const template = join(root, "template.plist");
  const bun = join(root, "bun");
  const script = join(root, "model-catalog.ts");
  const codexHome = join(root, "codex-home");
  const codexBinary = join(root, "codex");
  writeFileSync(
    template,
    "<string>__BUN_ABSOLUTE_PATH__</string><string>__SCRIPT_ABSOLUTE_PATH__</string><string>__CODEX_HOME_ABSOLUTE_PATH__</string><string>__CODEX_BINARY_ABSOLUTE_PATH__</string><string>__MODELS_CACHE_ABSOLUTE_PATH__</string>",
  );
  for (const path of [bun, script, codexBinary]) {
    writeFileSync(path, "fixture", { mode: 0o700 });
  }
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return [
    "render-launch-agent",
    "--template",
    template,
    "--output",
    join(root, "agent.plist"),
    "--bun",
    bun,
    "--script",
    script,
    "--codex-home",
    codexHome,
    "--codex-binary",
    codexBinary,
  ];
}

function writeSuccessfulCodex(root: string): string {
  const codex = join(root, "codex-success");
  writeFileSync(
    codex,
    `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.145.0-alpha.18");
  process.exit(0);
}
const catalog = { models: [
  { slug: "gpt-5.6-sol", multi_agent_version: "v2" },
  { slug: "gpt-5.6-terra", multi_agent_version: "v2" },
  { slug: "gpt-5.6-luna", multi_agent_version: "v1" },
] };
if (args.includes("--bundled")) {
  console.log(JSON.stringify(catalog));
  process.exit(0);
}
const override = args[args.indexOf("-c") + 1];
const path = JSON.parse(override.slice("model_catalog_json=".length));
console.log(await Bun.file(path).text());
`,
    { mode: 0o700 },
  );
  chmodSync(codex, 0o700);
  return codex;
}

describe("model catalog CLI", () => {
  test("reports topology-independent public usage", async () => {
    const result = await run([]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "usage: skizzles-model-catalog <refresh|service|render-launch-agent> [options]\n",
    });
    expect(result.stderr).not.toContain("model-catalog.ts");
  });

  test("renders through the production entrypoint with private permissions", async () => {
    const root = temporaryRoot();
    const result = await run(renderArgs(root));
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const output = join(root, "agent.plist");
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, output });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(readFileSync(output, "utf8")).toContain(
      join(root, "codex-home", "models_cache.json"),
    );
  });

  test("refreshes through the production entrypoint and stays quiet when unchanged", async () => {
    const root = temporaryRoot();
    const codex = writeSuccessfulCodex(root);
    const args = ["refresh", "--codex-home", root, "--codex-binary", codex];
    const first = await run(args);
    expect(first).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(first.stdout)).toMatchObject({
      ok: true,
      source: "bundled",
      updated: true,
      lunaOverlay: "applied",
    });
    const second = await run([...args, "--quiet-unchanged"]);
    expect(second).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("rejects unknown, duplicate, positional, and missing-value input", async () => {
    const root = temporaryRoot();
    const cases: [string[], string][] = [
      [[...renderArgs(root), "--unknown", "value"], "unknown option --unknown"],
      [
        [...renderArgs(root), "--template", join(root, "other")],
        "--template must not be repeated",
      ],
      [[...renderArgs(root), "positional"], "unexpected argument positional"],
      [
        [
          "refresh",
          "--codex-home",
          root,
          "--codex-binary",
          "/opt/codex",
          "--quiet-unchanged",
          "--quiet-unchanged",
        ],
        "--quiet-unchanged must not be repeated",
      ],
      [
        ["render-launch-agent", "--template", "--output", join(root, "out")],
        "--template requires a value",
      ],
    ];
    for (const [args, message] of cases) {
      const result = await run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    }
  });

  test("requires every host-wiring path value to be nonempty and absolute", async () => {
    const root = temporaryRoot();
    const render = renderArgs(root);
    const refresh = [
      "refresh",
      "--codex-home",
      root,
      "--codex-binary",
      "/opt/codex",
      "--output",
      join(root, "catalog.json"),
      "--status",
      join(root, "status.json"),
      "--cache",
      join(root, "cache.json"),
    ];
    for (const [base, flags] of [
      [
        render,
        [
          "--template",
          "--output",
          "--bun",
          "--script",
          "--codex-home",
          "--codex-binary",
        ],
      ],
      [
        refresh,
        ["--codex-home", "--codex-binary", "--output", "--status", "--cache"],
      ],
    ] as const) {
      for (const flag of flags) {
        for (const invalid of ["", "relative/path"]) {
          const args = [...base];
          const index = args.indexOf(flag);
          args[index + 1] = invalid;
          const result = await run(args);
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain(
            `${flag} requires a nonempty absolute path`,
          );
        }
      }
    }
  });

  test("rejects symlinked host-wiring inputs", async () => {
    const root = temporaryRoot();
    const args = renderArgs(root);
    const bunIndex = args.indexOf("--bun") + 1;
    const linkedBun = join(root, "linked-bun");
    const bun = args[bunIndex];
    if (bun === undefined) {
      throw new Error("missing Bun fixture path");
    }
    symlinkSync(bun, linkedBun);
    args[bunIndex] = linkedBun;
    const result = await run(args);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("symlink");
    expect(() => statSync(join(root, "agent.plist"))).toThrow();
  });

  test("service preserves last-good output and records bounded failures", async () => {
    const root = temporaryRoot();
    const codex = join(root, "codex");
    writeFileSync(
      codex,
      "#!/bin/sh\necho raw-output-secret\necho raw-error-secret >&2\nexit 9\n",
      { mode: 0o700 },
    );
    chmodSync(codex, 0o700);
    const output = join(root, "skizzles", "model-catalog.json");
    mkdirSync(join(root, "skizzles"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, "skizzles"), 0o700);
    writeFileSync(output, "last-good\n", { mode: 0o600 });
    const result = await run([
      "service",
      "--codex-home",
      root,
      "--codex-binary",
      codex,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("codex version command failed\n");
    expect(result.stderr).not.toContain("raw-output-secret");
    expect(result.stderr).not.toContain("raw-error-secret");
    expect(readFileSync(output, "utf8")).toBe("last-good\n");
    const status = JSON.parse(
      readFileSync(join(root, "skizzles", "model-catalog-status.json"), "utf8"),
    );
    expect(status).toMatchObject({
      ok: false,
      error: "model catalog child failure: codex version command failed",
    });
    expect(JSON.stringify(status)).not.toContain("raw-output-secret");
    expect(JSON.stringify(status)).not.toContain("raw-error-secret");
    expect(
      statSync(join(root, "skizzles", "model-catalog-status.json")).mode &
        0o777,
    ).toBe(0o600);
  });

  test("rejects aliased service paths without replacing last-good output", async () => {
    const root = temporaryRoot();
    const output = join(root, "catalog.json");
    writeFileSync(output, "last-good\n", { mode: 0o600 });
    const result = await run([
      "service",
      "--codex-home",
      root,
      "--codex-binary",
      "/missing/codex",
      "--output",
      output,
      "--status",
      output,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be distinct");
    expect(readFileSync(output, "utf8")).toBe("last-good\n");
  });
});
