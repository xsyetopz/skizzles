// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { assertAppServerPlatform } from "../src/codex-config/rpc.ts";
import { openConfigRpcSession } from "../src/codex-config.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects Windows before app-server process creation", () => {
  let spawned = false;
  expect(() => {
    assertAppServerPlatform("win32");
    spawned = true;
  }).toThrow("Windows Job Object support");
  expect(spawned).toBeFalse();
});
function fixture(config: string) {
  const home = `/tmp/skizzles-preview-${crypto.randomUUID()}`;
  const binary = `${home}-codex.mjs`;
  roots.push(home, binary);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), config);
  writeFileSync(
    binary,
    `#!${process.execPath}\nimport { createInterface } from "node:readline"; const h=process.env.CODEX_HOME; const l=createInterface({input:process.stdin}); l.on("line",x=>{const m=JSON.parse(x); if(m.id!==undefined) process.stdout.write(JSON.stringify({id:m.id,result:m.method==="initialize"?{}:{config:{},layers:[]}})+"\\n")});`,
  );
  chmodSync(binary, 0o755);
  return { home, binary };
}

describe("Codex dry-run snapshot bounds", () => {
  it("rejects deterministic in-place rewrite during copy and cleans preview", () => {
    const f = fixture('model_instructions_file = "changed.md"\n');
    const target = join(f.home, "changed.md");
    writeFileSync(target, "original");
    const script = `${f.home}-race.ts`;
    roots.push(script);
    writeFileSync(
      script,
      `import { mock } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
const readFile = fs.readFileSync.bind(fs);
const writeFile = fs.writeFileSync.bind(fs);
const fstat = fs.fstatSync.bind(fs);
const stat = fs.statSync.bind(fs);
const readdir = fs.readdirSync.bind(fs);
const target = ${JSON.stringify(target)};
const expected = stat(target, { bigint: true });
let changed = false;
mock.module("node:fs", () => ({
  ...fs,
  readFileSync(path: Parameters<typeof fs.readFileSync>[0], options?: unknown) {
    const bytes = readFile(path, options as never);
    if (typeof path === "number") {
      const actual = fstat(path, { bigint: true });
      if (!changed && actual.dev === expected.dev && actual.ino === expected.ino) {
        changed = true;
        writeFile(target, "changed!");
      }
    }
    return bytes;
  },
}));
const previews = () => readdir(tmpdir()).filter((name) => name.startsWith("skizzles-config-preview-")).sort();
const before = previews();
const { openConfigRpcSession } = await import(${JSON.stringify(`${import.meta.dir}/../src/codex-config.ts?race=${crypto.randomUUID()}`)});
try {
  await openConfigRpcSession({ codexHome: ${JSON.stringify(f.home)}, codexBinary: ${JSON.stringify(f.binary)}, dryRun: true });
  process.exit(71);
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  process.stdout.write(JSON.stringify({ changed, message, clean: JSON.stringify(previews()) === JSON.stringify(before) }));
}
`,
    );
    const result = Bun.spawnSync({
      cmd: [process.execPath, script],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      changed: true,
      message: expect.stringContaining("changed during dry-run snapshot"),
      clean: true,
    });
  });

  it("rejects nested config at depth boundary and cleans preview", async () => {
    const previewsBefore = previewDirectories();
    const chain = Array.from({ length: 18 }, (_, i) => `c${i}.toml`);
    const f = fixture('[agents.a]\nconfig_file = "c0.toml"\n');
    for (let i = 0; i < chain.length; i++) {
      const path = chain[i];
      if (!path) {
        throw new Error("nested config fixture is incomplete");
      }
      writeFileSync(
        join(f.home, path),
        `[agents.a]\nconfig_file = "${chain[i + 1] ?? "c0.toml"}"\n`,
      );
    }
    await expect(
      openConfigRpcSession({
        codexHome: f.home,
        codexBinary: f.binary,
        dryRun: true,
      }),
    ).rejects.toThrow("nested-config depth limit exceeded");
    expect(previewDirectories()).toEqual(previewsBefore);
  });

  it("accepts the nested-config depth boundary", async () => {
    const previewsBefore = previewDirectories();
    const chain = Array.from({ length: 16 }, (_, i) => `c${i}.toml`);
    const f = fixture('[agents.a]\nconfig_file = "c0.toml"\n');
    for (let i = 0; i < chain.length; i++) {
      const path = chain[i];
      if (!path) {
        throw new Error("nested config fixture is incomplete");
      }
      writeFileSync(
        join(f.home, path),
        chain[i + 1]
          ? `[agents.a]\nconfig_file = "${chain[i + 1]}"\n`
          : 'developer_instructions = "leaf"\n',
      );
    }
    const session = await openConfigRpcSession({
      codexHome: f.home,
      codexBinary: f.binary,
      dryRun: true,
    });
    await session.rpc.close();
    await session.cleanup();
    expect(previewDirectories()).toEqual(previewsBefore);
  });

  it("rejects one file beyond the referenced-file count boundary", async () => {
    const previewsBefore = previewDirectories();
    const f = fixture(
      Array.from(
        { length: 257 },
        (_, i) => `[agents.a${i}]\nconfig_file = "f${i}.md"`,
      ).join("\n"),
    );
    for (let i = 0; i < 257; i++) {
      writeFileSync(join(f.home, `f${i}.md`), "x");
    }
    await expect(
      openConfigRpcSession({
        codexHome: f.home,
        codexBinary: f.binary,
        dryRun: true,
      }),
    ).rejects.toThrow("referenced-file limit exceeded");
    expect(previewDirectories()).toEqual(previewsBefore);
  });

  it("accepts the referenced-file count boundary", async () => {
    const previewsBefore = previewDirectories();
    const f = fixture(
      Array.from(
        { length: 256 },
        (_, i) => `[agents.a${i}]\nconfig_file = "f${i}.md"`,
      ).join("\n"),
    );
    for (let i = 0; i < 256; i++) {
      writeFileSync(join(f.home, `f${i}.md`), "x");
    }
    const session = await openConfigRpcSession({
      codexHome: f.home,
      codexBinary: f.binary,
      dryRun: true,
    });
    await session.rpc.close();
    await session.cleanup();
    expect(previewDirectories()).toEqual(previewsBefore);
  });

  it("allows cycles by copied identity and cleans preview", async () => {
    const previewsBefore = previewDirectories();
    const f = fixture('[agents.a]\nconfig_file = "a.toml"\n');
    writeFileSync(
      join(f.home, "a.toml"),
      '[agents.a]\nconfig_file = "b.toml"\n',
    );
    writeFileSync(
      join(f.home, "b.toml"),
      '[agents.a]\nconfig_file = "a.toml"\n',
    );
    const session = await openConfigRpcSession({
      codexHome: f.home,
      codexBinary: f.binary,
      dryRun: true,
    });
    await session.rpc.close();
    await session.cleanup();
    expect(previewDirectories()).toEqual(previewsBefore);
  });
});

function previewDirectories(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("skizzles-config-preview-"))
    .sort();
}
