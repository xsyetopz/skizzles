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
const regexSyntaxPattern = /[.*+?^${}()|[\]\\]/g;

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

/**
 * Validate environment-backed Compose secret sources without inspecting or
 * retaining their values. The no-interpolation model also lets us reject
 * source-name references from plaintext service environment definitions.
 */
export function validateSecretEnvironmentModel(
  model: ComposeModel,
  declaredNames: readonly string[],
  environment: NodeJS.ProcessEnv,
): void {
  const declared = new Set(declaredNames);
  validateSecretDefinitions(model, declared, environment);
  validatePlaintextServiceEnvironment(model, declaredNames, declared);

  const referenced = referencedSecretNameInModel(model, declaredNames);
  if (referenced) {
    throw new Error(
      `Compose model references declared secret environment source: ${referenced}`,
    );
  }
}

function validateSecretDefinitions(
  model: ComposeModel,
  declared: ReadonlySet<string>,
  environment: NodeJS.ProcessEnv,
): void {
  for (const definition of Object.values(model.secrets ?? {})) {
    if (
      !isRecord(definition) ||
      typeof definition["environment"] !== "string"
    ) {
      continue;
    }
    const source = definition["environment"];
    if (!environmentNamePattern.test(source)) {
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
  }
}

function validatePlaintextServiceEnvironment(
  model: ComposeModel,
  declaredNames: readonly string[],
  declared: ReadonlySet<string>,
): void {
  for (const [serviceName, service] of Object.entries(model.services ?? {})) {
    validateServiceEnvironment(
      serviceName,
      service["environment"],
      declaredNames,
      declared,
    );
  }
}

function validateServiceEnvironment(
  serviceName: string,
  environment: unknown,
  declaredNames: readonly string[],
  declared: ReadonlySet<string>,
): void {
  if (Array.isArray(environment)) {
    validateServiceEnvironmentList(
      serviceName,
      environment,
      declaredNames,
      declared,
    );
  } else if (isRecord(environment)) {
    validateServiceEnvironmentMap(
      serviceName,
      environment,
      declaredNames,
      declared,
    );
  }
}

function validateServiceEnvironmentList(
  serviceName: string,
  environment: unknown[],
  declaredNames: readonly string[],
  declared: ReadonlySet<string>,
): void {
  for (const entry of environment) {
    if (typeof entry !== "string") {
      continue;
    }
    const separator = entry.indexOf("=");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? "" : entry.slice(separator + 1);
    rejectPlaintextSecretReference(
      serviceName,
      key,
      value,
      declaredNames,
      declared,
    );
  }
}

function validateServiceEnvironmentMap(
  serviceName: string,
  environment: Record<string, unknown>,
  declaredNames: readonly string[],
  declared: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(environment)) {
    rejectPlaintextSecretReference(
      serviceName,
      key,
      value,
      declaredNames,
      declared,
    );
  }
}

function rejectPlaintextSecretReference(
  serviceName: string,
  key: string,
  value: unknown,
  declaredNames: readonly string[],
  declared: ReadonlySet<string>,
): void {
  const referenced = declared.has(key)
    ? key
    : referencedSecretName(value, declaredNames);
  if (referenced) {
    throw plaintextSecretEnvironmentError(serviceName, referenced);
  }
}

function referencedSecretName(
  value: unknown,
  names: readonly string[],
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return names.find((name) => {
    const escaped = name.replace(regexSyntaxPattern, "\\$&");
    return new RegExp(
      `\\$${escaped}(?![A-Za-z0-9_])|\\$\\{${escaped}(?![A-Za-z0-9_])`,
    ).test(value);
  });
}

function referencedSecretNameInModel(
  model: ComposeModel,
  names: readonly string[],
): string | undefined {
  const pending: unknown[] = [model];
  while (pending.length > 0) {
    const value = pending.pop();
    const direct = referencedSecretName(value, names);
    if (direct) {
      return direct;
    }
    const keyReference = enqueueNestedValues(value, names, pending);
    if (keyReference) {
      return keyReference;
    }
  }
  return undefined;
}

function enqueueNestedValues(
  value: unknown,
  names: readonly string[],
  pending: unknown[],
): string | undefined {
  if (Array.isArray(value)) {
    for (const nested of value) {
      pending.push(nested);
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [key, nested] of Object.entries(value)) {
    const keyReference = referencedSecretName(key, names);
    if (keyReference) {
      return keyReference;
    }
    pending.push(nested);
  }
  return undefined;
}

function plaintextSecretEnvironmentError(
  service: string,
  source: string,
): Error {
  return new Error(
    `Compose service plaintext environment references declared secret source: ${service}:${source}`,
  );
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
