import { stringify as stringifyYaml } from "yaml";
import type { ComposeModel } from "./compose-model.ts";
import type { LabConfig } from "./config.ts";

export interface LabComposeContext {
  workspaceHostPath: string;
  owner: string;
  ownerKey: string;
  labId: string;
}

const labelPrefix = "io.openai.codex-container-lab";

export function generateBaseCompose(config: LabConfig): string | undefined {
  if (config.mode.kind === "compose") return undefined;
  const service: Record<string, unknown> = {
    working_dir: config.runtime.workspace,
    command: [...config.runtime.shell, "while :; do sleep 2147483647; done"],
  };
  if (config.mode.kind === "image") {
    service["image"] = config.mode.image;
  } else {
    service["build"] = {
      context: config.mode.context,
      dockerfile: config.mode.dockerfile,
    };
  }
  return stringifyYaml({ services: { [config.mode.commandService]: service } });
}

export function generateOverrideCompose(
  config: LabConfig,
  model: ComposeModel,
  context: LabComposeContext,
): string {
  const labels = managementLabels(context);
  const serviceNames = Object.keys(model.services ?? {});
  validateOverrideModel(config, model, serviceNames);

  const services = Object.fromEntries(
    serviceNames.map((name) => [
      name,
      generateServiceOverride(config, context, labels, name),
    ]),
  );
  const volumes = labelTopLevelResources(model.volumes, labels);
  const networks = labelTopLevelResources(model.networks, labels);
  return stringifyYaml({
    services,
    ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
    ...(Object.keys(networks).length > 0 ? { networks } : {}),
  });
}

function validateOverrideModel(
  config: LabConfig,
  model: ComposeModel,
  serviceNames: readonly string[],
): void {
  if (!serviceNames.includes(config.mode.commandService)) {
    throw new Error(
      `command service is absent from normalized Compose model: ${config.mode.commandService}`,
    );
  }
  for (const port of config.ports) {
    if (!serviceNames.includes(port.service)) {
      throw new Error(
        `declared port ${port.name} references absent service: ${port.service}`,
      );
    }
    const existing = asArray(model.services?.[port.service]?.["ports"]).some(
      (published) => publishedTarget(published) === port.target,
    );
    if (existing) {
      throw new Error(
        `declared port ${port.name} overlaps a project publication for ${port.service}:${port.target}`,
      );
    }
  }
}

function generateServiceOverride(
  config: LabConfig,
  context: LabComposeContext,
  labels: Record<string, string>,
  serviceName: string,
): Record<string, unknown> {
  const override: Record<string, unknown> = { labels };
  if (serviceName === config.mode.commandService) {
    override["init"] = true;
    override["working_dir"] = config.runtime.workspace;
    override["volumes"] = [
      {
        type: "bind",
        source: context.workspaceHostPath,
        target: config.runtime.workspace,
      },
    ];
    if (config.forwardEnvironment.length > 0) {
      // List form asks Compose to forward only these explicitly declared host names.
      override["environment"] = config.forwardEnvironment;
    }
    if (config.mode.kind === "dockerfile") {
      override["image"] = internalImageTag(context.ownerKey, context.labId);
      // Service labels apply to containers; build labels establish ownership on
      // the internally built image itself so cleanup can verify it independently.
      override["build"] = { labels };
    }
  }
  const servicePorts = config.ports.filter(
    (port) => port.service === serviceName,
  );
  if (servicePorts.length > 0) {
    override["ports"] = servicePorts.map(
      ({ target }) => `127.0.0.1::${target}`,
    );
  }
  return override;
}

function managementLabels(context: LabComposeContext): Record<string, string> {
  return {
    [`${labelPrefix}.managed`]: "true",
    [`${labelPrefix}.owner`]: context.owner,
    [`${labelPrefix}.lab`]: context.labId,
  };
}

function labelTopLevelResources(
  resources: Record<string, Record<string, unknown> | null> | undefined,
  labels: Record<string, string>,
): Record<string, { labels: Record<string, string> }> {
  return Object.fromEntries(
    Object.entries(resources ?? {})
      .filter(([, definition]) => !definition?.["external"])
      .map(([name]) => [name, { labels }]),
  );
}

export interface ComposeCommandOptions {
  projectName: string;
  overrideFile: string;
  baseFile?: string;
}

/** Arguments following the docker executable. File ordering is semantically significant. */
export function composeCommandArgs(
  config: LabConfig,
  options: ComposeCommandOptions,
): string[] {
  const sourceFiles =
    config.mode.kind === "compose"
      ? config.mode.files
      : options.baseFile
        ? [options.baseFile]
        : [];
  if (sourceFiles.length === 0) {
    throw new Error(
      "an internal base Compose file is required for image and dockerfile modes",
    );
  }
  return [
    "compose",
    "--project-directory",
    config.repoRoot,
    "--project-name",
    options.projectName,
    ...sourceFiles.flatMap((file) => ["-f", file]),
    "-f",
    options.overrideFile,
  ];
}

export function internalImageTag(ownerKey: string, labId: string): string {
  return `codex-container-lab:${ownerKey.slice(0, 24)}-${labId}`;
}

function publishedTarget(port: unknown): number | undefined {
  if (typeof port === "string") {
    const target = (port.split("/")[0] ?? "").split(":").at(-1);
    const parsed = Number(target);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  if (isRecord(port)) {
    const parsed = Number(port["target"]);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
