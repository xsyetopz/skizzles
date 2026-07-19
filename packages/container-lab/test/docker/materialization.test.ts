// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  composeCommandArgs,
  emptyComposeEnvironmentFile,
} from "../../src/compose/generation.ts";
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The causal Compose fixture and post-mutation assertions form one integration scenario.
test("materialized normalized source expands include and extends and ignores later source mutation", async () => {
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The direct Compose comparison and finding assertions form one integration scenario.
test("normalized materialized source reports interpolated privilege and port surfaces", async () => {
  if (!composeAvailable) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "container-lab-inspection-"));
  roots.push(root);
  const source = join(root, "source");
  const runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, "workspace"), { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "compose.yaml"),
    `services:
  dev:
    image: node:24
    privileged: \${LAB_PRIVILEGED}
    network_mode: \${LAB_NETWORK_MODE}
    use_api_socket: true
    volumes:
      - "\${LAB_MOUNT}"
    ports:
      - "\${LAB_PORT}:8080"
    secrets: [token]
secrets:
  token:
    environment: REGISTRY_TOKEN
`,
  );
  const config = parseLabConfig(
    `compose: { files: [compose.yaml], command_service: dev }
compose_environment: [LAB_PRIVILEGED, LAB_NETWORK_MODE, LAB_MOUNT, LAB_PORT]
secret_environment: [REGISTRY_TOKEN]
`,
    source,
  );
  const metadata = dockerLab({
    state: "provisioning",
    sourceRoot: source,
    manifestPath: join(source, ".codex-container-lab.yaml"),
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    modeKind: "compose",
    composeEnvironment: [
      "LAB_PRIVILEGED",
      "LAB_NETWORK_MODE",
      "LAB_MOUNT",
      "LAB_PORT",
    ],
    secretEnvironment: ["REGISTRY_TOKEN"],
  });
  const secret = "sentinel-registry-secret-e4bf47";
  const environment = {
    PATH: process.env["PATH"],
    LAB_PRIVILEGED: "true",
    LAB_NETWORK_MODE: "host",
    LAB_MOUNT: "/var/run/docker.sock:/var/run/docker.sock",
    LAB_PORT: "43210",
    REGISTRY_TOKEN: secret,
  };

  const prepared = await prepareLabRuntime(
    metadata,
    config,
    defaultDockerRunner,
    environment,
  );
  const normalizedEnvironment = {
    PATH: environment.PATH,
    LAB_PRIVILEGED: environment.LAB_PRIVILEGED,
    LAB_NETWORK_MODE: environment.LAB_NETWORK_MODE,
    LAB_MOUNT: environment.LAB_MOUNT,
    LAB_PORT: environment.LAB_PORT,
  };
  const direct = await defaultDockerRunner.run(
    [
      ...composeCommandArgs(config, {
        projectName: metadata.composeProject,
        environmentFile: emptyComposeEnvironmentFile,
      }),
      "config",
      "--no-env-resolution",
      "--format",
      "json",
    ],
    {
      env: normalizedEnvironment,
      maxOutputBytes: 16 * 1024 * 1024,
      rejectOnOutputLimit: true,
      timeoutMs: 30_000,
    },
  );

  expect(prepared.findings.map((finding) => finding.surface)).toEqual([
    "socket-bind",
    "privileged",
    "host-namespace",
    "host-bind",
    "socket-bind",
    "fixed-port",
    "non-loopback-port",
    "secret",
    "secret",
  ]);
  expect(
    prepared.findings.filter((finding) => finding.surface === "host-bind"),
  ).toHaveLength(1);
  expect(JSON.stringify(prepared.findings)).not.toContain(secret);
  expect(await Bun.file(prepared.sourceFile).text()).not.toContain(secret);
  expect(
    Buffer.from(await Bun.file(prepared.sourceFile).arrayBuffer()).equals(
      direct.stdout,
    ),
  ).toBe(true);
});
