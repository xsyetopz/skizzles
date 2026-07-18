import process from "node:process";
import { internalImageTag } from "../compose/generation.ts";
import type { DockerRunner, LabRuntime } from "../docker.ts";
import type { CommandResult } from "../process.ts";
import type { LabMetadata } from "../state/lab/contract.ts";
import { isRecord, scrubSecretEnvironment } from "./environment.ts";

const IMMUTABLE_IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export async function destroyLabStackInDocker(
  runtime: LabRuntime,
  runner: DockerRunner,
): Promise<void> {
  await cleanupLabLabelsInDocker(
    runtime.metadata,
    runtime.config.mode.kind === "dockerfile",
    runner,
    process.env,
  );
}

export async function cleanupLabLabelsInDocker(
  metadata: LabMetadata,
  removeInternalImage: boolean,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const scrubbedRunner = scrubDockerRunnerEnvironment(
    runner,
    metadata.secretEnvironment,
    environment,
  );
  const exactFilters = [
    "--filter",
    "label=io.openai.codex-container-lab.managed=true",
    "--filter",
    `label=io.openai.codex-container-lab.owner=${metadata.owner}`,
    "--filter",
    `label=io.openai.codex-container-lab.lab=${metadata.id}`,
  ];
  const resources: Array<{
    kind: "container" | "volume" | "network";
    list: string[];
    remove: string[];
    ownership?: string;
  }> = [
    {
      kind: "container",
      list: ["ps", "-aq", ...exactFilters],
      remove: ["rm", "-f", "-v"],
    },
    {
      kind: "volume",
      list: [
        "volume",
        "ls",
        "-q",
        ...exactFilters,
        "--filter",
        `label=com.docker.compose.project=${metadata.composeProject}`,
        "--filter",
        "label=com.docker.compose.volume",
      ],
      remove: ["volume", "rm"],
      ownership: "com.docker.compose.volume",
    },
    {
      kind: "network",
      list: [
        "network",
        "ls",
        "-q",
        ...exactFilters,
        "--filter",
        `label=com.docker.compose.project=${metadata.composeProject}`,
        "--filter",
        "label=com.docker.compose.network",
      ],
      remove: ["network", "rm"],
      ownership: "com.docker.compose.network",
    },
  ];
  for (const resource of resources) {
    const ids = await listBounded(resource.kind, resource.list, scrubbedRunner);
    if (resource.ownership && resource.kind !== "container") {
      for (const id of ids) {
        await verifyComposeResource(
          metadata,
          resource.kind,
          id,
          resource.ownership,
          scrubbedRunner,
        );
      }
    }
    if (ids.length > 0) {
      const removed = await scrubbedRunner.run([...resource.remove, ...ids], {
        allowFailure: true,
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024,
      });
      if (removed.code !== 0) {
        throw new Error(`failed to remove managed lab ${resource.kind}s`);
      }
    }
    const remaining = await listBounded(
      resource.kind,
      resource.list,
      scrubbedRunner,
    );
    if (remaining.length > 0) {
      throw new Error(`managed lab ${resource.kind}s remain after cleanup`);
    }
  }
  if (removeInternalImage) {
    await removeManagedInternalImage(metadata, scrubbedRunner);
  }
}

async function removeManagedInternalImage(
  metadata: LabMetadata,
  runner: DockerRunner,
): Promise<void> {
  const tag = internalImageTag(metadata.ownerKey, metadata.id);
  const inspected = await runner.run(
    [
      "image",
      "inspect",
      "--format",
      '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}',
      tag,
    ],
    { allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
  );
  if (inspected.code !== 0) {
    if (isExactMissingImage(inspected, tag)) {
      return;
    }
    throw new Error("unable to inspect managed Dockerfile image ownership");
  }

  let image: unknown;
  try {
    image = JSON.parse(inspected.stdout.toString());
  } catch {
    throw new Error("invalid managed Dockerfile image ownership inspection");
  }
  if (
    !isRecord(image) ||
    typeof image["id"] !== "string" ||
    !IMMUTABLE_IMAGE_ID.test(image["id"]) ||
    !isRecord(image["labels"])
  ) {
    throw new Error("invalid managed Dockerfile image ownership inspection");
  }
  if (
    image["labels"]["io.openai.codex-container-lab.managed"] !== "true" ||
    image["labels"]["io.openai.codex-container-lab.owner"] !== metadata.owner ||
    image["labels"]["io.openai.codex-container-lab.lab"] !== metadata.id
  ) {
    throw new Error(
      "refusing to remove Dockerfile image without exact ownership labels",
    );
  }

  const removed = await runner.run(["image", "rm", image["id"]], {
    allowFailure: true,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (removed.code !== 0) {
    throw new Error("failed to remove managed Dockerfile image");
  }
}

function isExactMissingImage(result: CommandResult, tag: string): boolean {
  if (result.stdout.toString().trim() !== "") {
    return false;
  }
  const diagnostic = result.stderr.toString().trim();
  return (
    diagnostic === `Error: No such image: ${tag}` ||
    diagnostic === `Error response from daemon: No such image: ${tag}`
  );
}

async function listBounded(
  kind: string,
  args: string[],
  runner: DockerRunner,
): Promise<string[]> {
  const listed = await runner.run(args, {
    allowFailure: true,
    timeoutMs: 15_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (listed.code !== 0) {
    throw new Error(`failed to list managed lab ${kind}s`);
  }
  const ids = listed.stdout.toString().trim().split("\n").filter(Boolean);
  if (ids.length > 1_000) {
    throw new Error(`managed lab ${kind}s exceed cleanup bound`);
  }
  return ids;
}

async function verifyComposeResource(
  metadata: LabMetadata,
  kind: "volume" | "network",
  id: string,
  ownershipLabel: string,
  runner: DockerRunner,
): Promise<void> {
  const inspected = await runner.run(
    [kind, "inspect", id, "--format", "{{json .Labels}}"],
    {
      allowFailure: true,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    },
  );
  if (inspected.code !== 0) {
    throw new Error(`unable to verify managed ${kind} ownership`);
  }
  let labels: unknown;
  try {
    labels = JSON.parse(inspected.stdout.toString());
  } catch {
    throw new Error(`invalid managed ${kind} ownership labels`);
  }
  if (!isRecord(labels)) {
    throw new Error(`invalid managed ${kind} ownership labels`);
  }
  if (
    labels["io.openai.codex-container-lab.managed"] !== "true" ||
    labels["io.openai.codex-container-lab.owner"] !== metadata.owner ||
    labels["io.openai.codex-container-lab.lab"] !== metadata.id ||
    labels["com.docker.compose.project"] !== metadata.composeProject ||
    typeof labels[ownershipLabel] !== "string"
  ) {
    throw new Error(
      `refusing to remove ${kind} without exact ownership labels`,
    );
  }
}

function scrubDockerRunnerEnvironment(
  runner: DockerRunner,
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): DockerRunner {
  if (names.length === 0) {
    return runner;
  }
  return {
    run: async (args, options = {}) =>
      await runner.run(args, {
        ...options,
        env: scrubSecretEnvironment(names, options.env ?? environment),
      }),
    spawn: (args, options = {}) =>
      runner.spawn(args, {
        ...options,
        env: scrubSecretEnvironment(names, options.env ?? environment),
      }),
  };
}
