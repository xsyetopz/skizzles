import type { ComposeModel } from "./contract.ts";

export type PrivilegeSurface =
  | "host-bind"
  | "socket-bind"
  | "privileged"
  | "host-namespace"
  | "device"
  | "capability"
  | "secret"
  | "config"
  | "fixed-port"
  | "non-loopback-port";

export interface ComposeInspectionFinding {
  service?: string;
  surface: PrivilegeSurface;
  detail: string;
}

const hostNamespaceKeys = [
  "pid",
  "ipc",
  "network_mode",
  "uts",
  "userns_mode",
  "cgroup",
] as const;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const socketPathPattern =
  /(?:^|\/)docker\.sock$|(?:^|\/)podman\.sock$|\.sock$/i;

/** Report trusted-project privilege surfaces without returning paths, values, or secret names. */
export function inspectComposeModel(
  model: ComposeModel,
): ComposeInspectionFinding[] {
  const findings: ComposeInspectionFinding[] = [];
  for (const [serviceName, service] of Object.entries(model.services ?? {})) {
    inspectService(findings, serviceName, service);
  }
  inspectTopLevelResources(findings, model);
  return findings;
}

function inspectService(
  findings: ComposeInspectionFinding[],
  serviceName: string,
  service: Record<string, unknown>,
): void {
  inspectServicePrivileges(findings, serviceName, service);
  inspectServiceMappings(findings, serviceName, service);
  inspectServiceAttachments(findings, serviceName, service);
  inspectBuildCredentials(findings, serviceName, service["build"]);
}

function inspectServicePrivileges(
  findings: ComposeInspectionFinding[],
  serviceName: string,
  service: Record<string, unknown>,
): void {
  if (service["use_api_socket"] === true) {
    add(
      findings,
      serviceName,
      "socket-bind",
      "container engine API socket enabled; details redacted",
    );
  }
  if (service["privileged"] === true) {
    add(findings, serviceName, "privileged", "privileged mode enabled");
  }
  for (const key of hostNamespaceKeys) {
    if (service[key] === "host") {
      add(
        findings,
        serviceName,
        "host-namespace",
        `${key} uses host namespace`,
      );
    }
  }
  addCountFinding(
    findings,
    serviceName,
    "capability",
    asArray(service["cap_add"]).length,
    "added capability(s)",
  );
  addCountFinding(
    findings,
    serviceName,
    "device",
    asArray(service["devices"]).length,
    "host device mapping(s); paths redacted",
  );
}

function inspectServiceMappings(
  findings: ComposeInspectionFinding[],
  serviceName: string,
  service: Record<string, unknown>,
): void {
  for (const volume of asArray(service["volumes"])) {
    inspectVolume(findings, serviceName, volume);
  }
  for (const port of asArray(service["ports"])) {
    inspectPort(findings, serviceName, port);
  }
}

function inspectServiceAttachments(
  findings: ComposeInspectionFinding[],
  serviceName: string,
  service: Record<string, unknown>,
): void {
  addCountFinding(
    findings,
    serviceName,
    "secret",
    asArray(service["secrets"]).length,
    "secret attachment(s); names redacted",
  );
  addCountFinding(
    findings,
    serviceName,
    "config",
    asArray(service["configs"]).length,
    "config attachment(s); names redacted",
  );
}

function inspectBuildCredentials(
  findings: ComposeInspectionFinding[],
  serviceName: string,
  value: unknown,
): void {
  if (!isRecord(value)) {
    return;
  }
  const ssh = value["ssh"];
  if (
    (Array.isArray(ssh) && ssh.length > 0) ||
    (isRecord(ssh) && Object.keys(ssh).length > 0) ||
    typeof ssh === "string"
  ) {
    add(
      findings,
      serviceName,
      "secret",
      "build SSH forwarding enabled; identities redacted",
    );
  }
  addCountFinding(
    findings,
    serviceName,
    "secret",
    asArray(value["secrets"]).length,
    "build secret attachment(s); names redacted",
  );
}

function inspectTopLevelResources(
  findings: ComposeInspectionFinding[],
  model: ComposeModel,
): void {
  const topSecrets = Object.keys(model.secrets ?? {}).length;
  if (topSecrets > 0) {
    findings.push({
      surface: "secret",
      detail: `${topSecrets} top-level secret definition(s); names redacted`,
    });
  }
  const topConfigs = Object.keys(model.configs ?? {}).length;
  if (topConfigs > 0) {
    findings.push({
      surface: "config",
      detail: `${topConfigs} top-level config definition(s); names redacted`,
    });
  }
}

/** Validate every host-environment read preserved by the raw Compose model. */
export function validateComposeEnvironmentModel(
  model: ComposeModel,
  composeNames: readonly string[],
  secretNames: readonly string[],
  environment: NodeJS.ProcessEnv,
): void {
  const compose = new Set(composeNames);
  const secrets = new Set(secretNames);
  validateInterpolation(model, compose);
  validateImplicitServiceEnvironment(model, compose, secrets);
  rejectServiceEnvironmentFiles(model);
  validateImplicitBuildArguments(model, compose);
  validateSecretDefinitions(model, secrets, environment);
  rejectEnvironmentBackedConfigs(model);
}

function rejectServiceEnvironmentFiles(model: ComposeModel): void {
  for (const service of Object.values(model.services ?? {})) {
    if (Object.hasOwn(service, "env_file")) {
      throw new Error(
        "Compose service env_file is not supported; declare explicit environment inputs",
      );
    }
  }
}

function validateSecretDefinitions(
  model: ComposeModel,
  declared: ReadonlySet<string>,
  environment: NodeJS.ProcessEnv,
): void {
  const used = new Set<string>();
  for (const definition of Object.values(model.secrets ?? {})) {
    if (!(isRecord(definition) && Object.hasOwn(definition, "environment"))) {
      continue;
    }
    const source = definition["environment"];
    if (typeof source !== "string" || !environmentNamePattern.test(source)) {
      throw new Error(
        "Compose secret environment source is invalid or undeclared",
      );
    }
    if (!declared.has(source)) {
      throw new Error(
        `Compose secret environment source is not declared: ${source}`,
      );
    }
    if (
      !Object.hasOwn(environment, source) ||
      typeof environment[source] !== "string"
    ) {
      throw new Error(
        `Compose secret environment source is unavailable: ${source}`,
      );
    }
    used.add(source);
  }
  for (const source of declared) {
    if (!used.has(source)) {
      throw new Error(
        `declared secret environment source is not used by a top-level secret: ${source}`,
      );
    }
  }
}

function validateImplicitServiceEnvironment(
  model: ComposeModel,
  compose: ReadonlySet<string>,
  secrets: ReadonlySet<string>,
): void {
  for (const [serviceName, service] of Object.entries(model.services ?? {})) {
    const serviceEnvironment = service["environment"];
    if (Array.isArray(serviceEnvironment)) {
      for (const entry of serviceEnvironment) {
        if (typeof entry !== "string") {
          continue;
        }
        const separator = entry.indexOf("=");
        const name = separator < 0 ? entry : entry.slice(0, separator);
        rejectSecretServiceEnvironment(serviceName, name, secrets);
        if (separator < 0) {
          requireComposeAuthorization(name, compose, "service environment");
        }
      }
    } else if (isRecord(serviceEnvironment)) {
      for (const [name, value] of Object.entries(serviceEnvironment)) {
        rejectSecretServiceEnvironment(serviceName, name, secrets);
        if (value === null) {
          requireComposeAuthorization(name, compose, "service environment");
        }
      }
    }
  }
}

function validateImplicitBuildArguments(
  model: ComposeModel,
  compose: ReadonlySet<string>,
): void {
  for (const service of Object.values(model.services ?? {})) {
    const build = service["build"];
    if (!isRecord(build)) {
      continue;
    }
    const args = build["args"];
    if (Array.isArray(args)) {
      for (const entry of args) {
        if (typeof entry === "string" && !entry.includes("=")) {
          requireComposeAuthorization(entry, compose, "build argument");
        }
      }
    } else if (isRecord(args)) {
      for (const [name, value] of Object.entries(args)) {
        if (value === null) {
          requireComposeAuthorization(name, compose, "build argument");
        }
      }
    }
  }
}

function validateInterpolation(
  model: ComposeModel,
  compose: ReadonlySet<string>,
): void {
  const pending: unknown[] = [model];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      for (const name of interpolationNames(value)) {
        requireComposeAuthorization(name, compose, "interpolation");
      }
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (isRecord(value)) {
      pending.push(...Object.values(value));
    }
  }
}

function interpolationNames(value: string): string[] {
  const names: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "$") {
      continue;
    }
    const next = value[index + 1];
    if (next === "$") {
      index++;
      continue;
    }
    const start = next === "{" ? index + 2 : index + 1;
    const first = value[start];
    if (!(first && /[A-Za-z_]/.test(first))) {
      continue;
    }
    let end = start + 1;
    while (end < value.length && /[A-Za-z0-9_]/.test(value[end] ?? "")) {
      end++;
    }
    names.push(value.slice(start, end));
    index = end - 1;
  }
  return names;
}

function requireComposeAuthorization(
  name: string,
  compose: ReadonlySet<string>,
  kind: string,
): void {
  if (!(environmentNamePattern.test(name) && compose.has(name))) {
    throw new Error(`Compose ${kind} reads undeclared environment: ${name}`);
  }
}

function rejectSecretServiceEnvironment(
  service: string,
  name: string,
  secrets: ReadonlySet<string>,
): void {
  if (secrets.has(name)) {
    throw new Error(
      `Compose service plaintext environment references declared secret source: ${service}:${name}`,
    );
  }
}

function rejectEnvironmentBackedConfigs(model: ComposeModel): void {
  for (const definition of Object.values(model.configs ?? {})) {
    if (isRecord(definition) && Object.hasOwn(definition, "environment")) {
      throw new Error("Compose top-level configs.environment is not supported");
    }
  }
}

function inspectVolume(
  findings: ComposeInspectionFinding[],
  service: string,
  volume: unknown,
): void {
  let isBind = false;
  let source = "";
  if (typeof volume === "string") {
    source = volume.split(":", 1)[0] ?? "";
    isBind =
      source.startsWith("/") ||
      source.startsWith(".") ||
      source.startsWith("~");
  } else if (isRecord(volume)) {
    isBind = volume["type"] === "bind";
    source = typeof volume["source"] === "string" ? volume["source"] : "";
  }
  if (!isBind) {
    return;
  }
  add(findings, service, "host-bind", "host bind mount; path redacted");
  if (socketPathPattern.test(source)) {
    add(
      findings,
      service,
      "socket-bind",
      "host socket bind mount; path redacted",
    );
  }
}

function inspectPort(
  findings: ComposeInspectionFinding[],
  service: string,
  port: unknown,
): void {
  let hostIp: string | undefined;
  let published: string | undefined;
  if (typeof port === "string") {
    const raw = port.split("/")[0] ?? "";
    const parts = raw.split(":");
    if (parts.length === 3) {
      [hostIp, published] = parts;
    } else if (parts.length === 2) {
      published = parts[0];
    }
  } else if (isRecord(port)) {
    hostIp = typeof port["host_ip"] === "string" ? port["host_ip"] : undefined;
    published =
      port["published"] === undefined ? undefined : String(port["published"]);
  }
  if (published && published !== "0") {
    add(
      findings,
      service,
      "fixed-port",
      "fixed host port publication; port redacted",
    );
  }
  if (
    published !== undefined &&
    hostIp !== "127.0.0.1" &&
    hostIp !== "::1" &&
    hostIp !== "localhost"
  ) {
    add(
      findings,
      service,
      "non-loopback-port",
      "port is published beyond explicit loopback; address redacted",
    );
  }
}

function add(
  findings: ComposeInspectionFinding[],
  service: string,
  surface: PrivilegeSurface,
  detail: string,
): void {
  findings.push({ service, surface, detail });
}

function addCountFinding(
  findings: ComposeInspectionFinding[],
  service: string,
  surface: PrivilegeSurface,
  count: number,
  detail: string,
): void {
  if (count > 0) {
    add(findings, service, surface, `${count} ${detail}`);
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
