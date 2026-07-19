// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseLabConfig } from "../../src/config.ts";
import {
  composeCommand,
  defaultDockerRunner,
  prepareLabRuntime,
} from "../../src/docker.ts";
import { dockerLab } from "./support.ts";

const roots: string[] = [];
const composeAvailable =
  Bun.spawnSync({
    cmd: ["docker", "compose", "version"],
    env: { PATH: process.env["PATH"] },
    stderr: "ignore",
    stdout: "ignore",
  }).exitCode === 0;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("materialized raw model expands include and extends and ignores later source mutation", async () => {
  if (!composeAvailable) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "container-lab-materialized-"));
  roots.push(root);
  const source = join(root, "source");
  const runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, "workspace"), { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "compose.yaml"),
    `include:
  - fragment.yaml
services:
  dev:
    extends:
      file: common.yaml
      service: common
`,
  );
  await writeFile(
    join(source, "common.yaml"),
    "services: { common: { image: node:24, command: [echo, stable] } }\n",
  );
  await writeFile(
    join(source, "fragment.yaml"),
    "services: { sidecar: { image: node:24 } }\n",
  );
  const config = parseLabConfig(
    "compose: { files: [compose.yaml], command_service: dev }\n",
    source,
  );
  const metadata = dockerLab({
    state: "provisioning",
    sourceRoot: source,
    manifestPath: join(source, ".codex-container-lab.yaml"),
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    modeKind: "compose",
  });
  const environment = { PATH: process.env["PATH"] };

  const prepared = await prepareLabRuntime(
    metadata,
    config,
    defaultDockerRunner,
    environment,
  );
  const materialized = JSON.parse(
    await Bun.file(prepared.sourceFile).text(),
  ) as Record<string, unknown>;
  expect(Object.keys(materialized["services"] ?? {}).sort()).toEqual([
    "dev",
    "sidecar",
  ]);
  expect(JSON.stringify(materialized)).not.toContain('"include"');
  expect(JSON.stringify(materialized)).not.toContain('"extends"');

  const before = await composeCommand(
    prepared,
    ["config", "--no-env-resolution", "--format", "json"],
    { timeoutMs: 30_000 },
    defaultDockerRunner,
    environment,
  );
  await writeFile(
    join(source, "compose.yaml"),
    "services: { dev: { image: node:24, command: [echo, mutated-main] } }\n",
  );
  await writeFile(
    join(source, "common.yaml"),
    "services: { common: { image: node:24, command: [echo, mutated-extends] } }\n",
  );
  await writeFile(
    join(source, "fragment.yaml"),
    "services: { injected: { image: node:24 } }\n",
  );
  const after = await composeCommand(
    prepared,
    ["config", "--no-env-resolution", "--format", "json"],
    { timeoutMs: 30_000 },
    defaultDockerRunner,
    environment,
  );

  expect(after.stdout.equals(before.stdout)).toBe(true);
  expect(after.stdout.toString()).not.toContain("mutated");
  expect(after.stdout.toString()).not.toContain("injected");
});
