import { posix } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not follow yaml's package exports; yaml is a declared runtime dependency.
import { parse as parseYaml } from "yaml";
import { parseManifestEnvironmentLists } from "./environment.ts";

export const manifestName = ".codex-container-lab.yaml";

const serviceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const uriSchemePattern = /^[a-z][a-z0-9+.-]*$/;

type IssuePath = Array<string | number>;
interface ValidationIssue {
  path: IssuePath;
  message: string;
}

interface ComposeManifest {
  files: string[];
  command_service: string;
}

interface DockerfileManifest {
  path: string;
  context: string;
  service: string;
}

interface ImageManifest {
  name: string;
  service: string;
}

interface PortManifest {
  service: string;
  target: number;
  scheme?: string;
}

export interface RuntimeConfig {
  workspace: string;
  shell: string[];
}

export interface ParsedManifest {
  compose?: ComposeManifest;
  dockerfile?: DockerfileManifest;
  image?: ImageManifest;
  runtime: RuntimeConfig;
  ports: Record<string, PortManifest>;
  environment: string[];
  compose_environment: string[];
  secret_environment: string[];
}

function isValidContainerPath(value: string, allowRoot: boolean): boolean {
  if (
    !value.startsWith("/") ||
    value.includes("\0") ||
    (!allowRoot && value === "/")
  ) {
    return false;
  }
  return (
    posix.normalize(value) === value &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function addIssue(
  issues: ValidationIssue[],
  path: IssuePath,
  message: string,
): void {
  issues.push({ path, message });
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: IssuePath,
  issues: ValidationIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      addIssue(issues, [...path, key], "unknown key");
    }
  }
}

function asObject(
  value: unknown,
  path: IssuePath,
  issues: ValidationIssue[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return undefined;
  }
  return value;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  path: IssuePath,
  issues: ValidationIssue[],
  validate: (candidate: unknown) => string | undefined,
  message: string,
): string | undefined {
  const fieldPath = [...path, key];
  if (!hasOwn(value, key)) {
    addIssue(issues, fieldPath, "is required");
    return undefined;
  }
  const parsed = validate(value[key]);
  if (parsed === undefined) {
    addIssue(issues, fieldPath, message);
  }
  return parsed;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: IssuePath,
  issues: ValidationIssue[],
  validate: (candidate: unknown) => string | undefined,
  message: string,
  defaultValue: string,
): string {
  if (!hasOwn(value, key)) {
    return defaultValue;
  }
  const parsed = validate(value[key]);
  if (parsed === undefined) {
    addIssue(issues, [...path, key], message);
    return defaultValue;
  }
  return parsed;
}

function parseServiceName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = value.trim();
  return serviceNamePattern.test(parsed) ? parsed : undefined;
}

function parseRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = value.trim();
  return parsed.length > 0 ? parsed : undefined;
}

function parseShellArgument(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return undefined;
  }
  return value;
}

function parseNonEmptyTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = value.trim();
  return parsed.length > 0 ? parsed : undefined;
}

function parseStringArray(
  value: unknown,
  path: IssuePath,
  issues: ValidationIssue[],
  itemParser: (candidate: unknown) => string | undefined,
  itemMessage: string,
  minimumLength: number,
): string[] {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "must be an array");
    return [];
  }
  if (value.length < minimumLength) {
    addIssue(
      issues,
      path,
      `must contain at least ${minimumLength} item${
        minimumLength === 1 ? "" : "s"
      }`,
    );
  }
  const parsed: string[] = [];
  for (const [index, item] of value.entries()) {
    const candidate = itemParser(item);
    if (candidate === undefined) {
      addIssue(issues, [...path, index], itemMessage);
    } else {
      parsed.push(candidate);
    }
  }
  return parsed;
}

function parseCompose(
  value: unknown,
  path: IssuePath,
  issues: ValidationIssue[],
): ComposeManifest | undefined {
  const record = asObject(value, path, issues);
  if (!record) {
    return undefined;
  }
  rejectUnknownKeys(record, ["files", "command_service"], path, issues);
  let files: string[] = [];
  if (hasOwn(record, "files")) {
    files = parseStringArray(
      record["files"],
      [...path, "files"],
      issues,
      parseRelativePath,
      "must be a non-empty relative path",
      1,
    );
  } else {
    addIssue(issues, [...path, "files"], "is required");
  }
  const commandService = requiredString(
    record,
    "command_service",
    path,
    issues,
    parseServiceName,
    "must be a Compose service name",
  );
  return commandService === undefined
    ? undefined
    : { files, command_service: commandService };
}

function parseDockerfile(
  value: unknown,
  path: IssuePath,
  issues: ValidationIssue[],
): DockerfileManifest | undefined {
  const record = asObject(value, path, issues);
  if (!record) {
    return undefined;
  }
  rejectUnknownKeys(record, ["path", "context", "service"], path, issues);
  const dockerfilePath = requiredString(
    record,
    "path",
    path,
    issues,
    parseRelativePath,
    "must be a non-empty relative path",
  );
  const context = optionalString(
    record,
    "context",
    path,
    issues,
    parseRelativePath,
    "must be a non-empty relative path",
    ".",
  );
  const service = requiredString(
    record,
    "service",
    path,
    issues,
    parseServiceName,
    "must be a Compose service name",
  );
  return dockerfilePath === undefined || service === undefined
    ? undefined
    : { path: dockerfilePath, context, service };
}

function parseImage(
  value: unknown,
  path: IssuePath,
  issues: ValidationIssue[],
): ImageManifest | undefined {
  const record = asObject(value, path, issues);
  if (!record) {
    return undefined;
  }
  rejectUnknownKeys(record, ["name", "service"], path, issues);
  const name = requiredString(
    record,
    "name",
    path,
    issues,
    parseNonEmptyTrimmedString,
    "must be a non-empty string",
  );
  const service = requiredString(
    record,
    "service",
    path,
    issues,
    parseServiceName,
    "must be a Compose service name",
  );
  return name === undefined || service === undefined
    ? undefined
    : { name, service };
}

function parseRuntime(
  value: unknown,
  path: IssuePath,
  issues: ValidationIssue[],
): RuntimeConfig {
  if (value === undefined) {
    return { workspace: "/workspace", shell: ["/bin/sh", "-lc"] };
  }
  const record = asObject(value, path, issues);
  if (!record) {
    return { workspace: "/workspace", shell: ["/bin/sh", "-lc"] };
  }
  rejectUnknownKeys(record, ["workspace", "shell"], path, issues);
  const workspace = optionalString(
    record,
    "workspace",
    path,
    issues,
    (candidate) => (typeof candidate === "string" ? candidate : undefined),
    "must be a string",
    "/workspace",
  );
  const shell = hasOwn(record, "shell")
    ? parseStringArray(
        record["shell"],
        [...path, "shell"],
        issues,
        parseShellArgument,
        "must be a non-empty shell argument without NUL",
        1,
      )
    : ["/bin/sh", "-lc"];
  return { workspace, shell };
}

function parsePort(
  value: unknown,
  path: IssuePath,
  issues: ValidationIssue[],
): PortManifest | undefined {
  const record = asObject(value, path, issues);
  if (!record) {
    return undefined;
  }
  rejectUnknownKeys(record, ["service", "target", "scheme"], path, issues);
  const service = requiredString(
    record,
    "service",
    path,
    issues,
    parseServiceName,
    "must be a Compose service name",
  );
  let target: number | undefined;
  if (!hasOwn(record, "target")) {
    addIssue(issues, [...path, "target"], "is required");
  } else if (
    typeof record["target"] !== "number" ||
    !Number.isInteger(record["target"]) ||
    record["target"] < 1 ||
    record["target"] > 65535
  ) {
    addIssue(
      issues,
      [...path, "target"],
      "must be an integer between 1 and 65535",
    );
  } else {
    target = record["target"];
  }
  let scheme: string | undefined;
  if (hasOwn(record, "scheme")) {
    if (
      typeof record["scheme"] !== "string" ||
      !uriSchemePattern.test(record["scheme"])
    ) {
      addIssue(issues, [...path, "scheme"], "must be a URI scheme");
    } else {
      scheme = record["scheme"];
    }
  }
  return service === undefined || target === undefined
    ? undefined
    : { service, target, ...(scheme === undefined ? {} : { scheme }) };
}

function parsePorts(
  value: unknown,
  path: IssuePath,
  issues: ValidationIssue[],
): Record<string, PortManifest> {
  if (value === undefined) {
    return {};
  }
  const record = asObject(value, path, issues);
  if (!record) {
    return {};
  }
  const parsed: Record<string, PortManifest> = {};
  for (const [name, port] of Object.entries(record)) {
    const parsedName = parseServiceName(name);
    if (parsedName === undefined) {
      addIssue(issues, [...path, name], "must be a Compose service name");
    }
    const parsedPort = parsePort(port, [...path, name], issues);
    if (parsedPort && parsedName !== undefined) {
      parsed[parsedName] = parsedPort;
    }
  }
  return parsed;
}

function validateManifest(document: unknown): ParsedManifest {
  const issues: ValidationIssue[] = [];
  const manifest = asObject(document, [], issues);
  if (!manifest) {
    throw new Error(
      `invalid ${manifestName}: ${issues.map(formatIssue).join("; ")}`,
    );
  }
  rejectUnknownKeys(
    manifest,
    [
      "compose",
      "dockerfile",
      "image",
      "runtime",
      "ports",
      "environment",
      "compose_environment",
      "secret_environment",
    ],
    [],
    issues,
  );

  const modes = parseManifestModes(manifest, issues);
  const runtime = parseRuntime(manifest["runtime"], ["runtime"], issues);
  validateRuntimePaths(runtime, issues);
  const ports = parsePorts(manifest["ports"], ["ports"], issues);
  const {
    composeEnvironment,
    environment,
    secretEnvironment,
    issues: environmentIssues,
  } = parseManifestEnvironmentLists(manifest);
  issues.push(
    ...environmentIssues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  );
  validateUniquePortTargets(ports, issues);

  if (issues.length > 0) {
    throw new Error(
      `invalid ${manifestName}: ${issues.map(formatIssue).join("; ")}`,
    );
  }
  return {
    ...modes,
    runtime,
    ports,
    environment,
    compose_environment: composeEnvironment,
    secret_environment: secretEnvironment,
  };
}

function parseManifestModes(
  manifest: Record<string, unknown>,
  issues: ValidationIssue[],
): Pick<ParsedManifest, "compose" | "dockerfile" | "image"> {
  const compose = hasOwn(manifest, "compose")
    ? parseCompose(manifest["compose"], ["compose"], issues)
    : undefined;
  const dockerfile = hasOwn(manifest, "dockerfile")
    ? parseDockerfile(manifest["dockerfile"], ["dockerfile"], issues)
    : undefined;
  const image = hasOwn(manifest, "image")
    ? parseImage(manifest["image"], ["image"], issues)
    : undefined;
  const modeCount = ["compose", "dockerfile", "image"].filter((key) =>
    hasOwn(manifest, key),
  ).length;
  if (modeCount !== 1) {
    addIssue(
      issues,
      [],
      "exactly one of compose, dockerfile, or image must be configured",
    );
  }
  return {
    ...(compose === undefined ? {} : { compose }),
    ...(dockerfile === undefined ? {} : { dockerfile }),
    ...(image === undefined ? {} : { image }),
  };
}

function validateRuntimePaths(
  runtime: RuntimeConfig,
  issues: ValidationIssue[],
): void {
  if (!isValidContainerPath(runtime.workspace, false)) {
    addIssue(
      issues,
      ["runtime", "workspace"],
      "must be a normalized absolute container path other than /",
    );
  }
  const shellExecutable = runtime.shell[0];
  if (
    shellExecutable === undefined ||
    !isValidContainerPath(shellExecutable, false)
  ) {
    addIssue(
      issues,
      ["runtime", "shell"],
      "first argv item must be a normalized absolute executable path",
    );
  }
}

function validateUniquePortTargets(
  ports: Record<string, PortManifest>,
  issues: ValidationIssue[],
): void {
  const portTargets = Object.values(ports).map(
    (port) => `${port.service}:${port.target}`,
  );
  if (new Set(portTargets).size !== portTargets.length) {
    addIssue(issues, ["ports"], "service and target pairs must be unique");
  }
}

export function parseLabManifest(
  source: string,
  sourcePath: string,
): ParsedManifest {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    throw new Error(
      `invalid YAML in ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return validateManifest(document);
}

function formatIssue(issue: ValidationIssue): string {
  const location = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${location}${issue.message}`;
}
