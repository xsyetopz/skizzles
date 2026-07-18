// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";

const analyzer = join(import.meta.dir, "../../src/main.ts");
const fixtureRoots: string[] = [];

type AnalyzerEnvironment = Record<string, string | undefined> & {
  CODEX_HOME?: string | undefined;
};

afterEach(async () => {
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

export const rootId = "11111111-1111-1111-1111-111111111111";
export const childId = "22222222-2222-2222-2222-222222222222";
export const guardianId = "33333333-3333-3333-3333-333333333333";
export const timestamp = "2026-07-02T12:00:00.000Z";

export async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "skizzles-usage-analyzer-"));
  fixtureRoots.push(home);
  return home;
}

export function runAnalyzer(
  home: string,
  args: string[],
  extraEnv: AnalyzerEnvironment = {},
): ReturnType<typeof Bun.spawnSync> {
  const env: AnalyzerEnvironment = { ...process.env };
  Object.assign(env, extraEnv);
  if (!("CODEX_HOME" in extraEnv)) {
    env.CODEX_HOME = home;
  } else if (extraEnv.CODEX_HOME === undefined) {
    env.CODEX_HOME = undefined;
  }
  return Bun.spawnSync({
    cmd: [process.execPath, analyzer, ...args],
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

export function commandOutput(result: ReturnType<typeof Bun.spawnSync>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

export async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const content = await readFile(full);
        files[relative(root, full)] = createHash("sha256")
          .update(content)
          .digest("hex");
      }
    }
  }
  await visit(root);
  return files;
}

export async function writeJsonl(
  path: string,
  events: unknown[],
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}
