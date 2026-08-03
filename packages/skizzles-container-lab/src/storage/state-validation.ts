import { basename, isAbsolute, join, parse, posix, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { composeCommandArgs, internalImageTag } from "../compose/definition";
import { manifestName } from "../compose/config";
import { safeStateName } from "./files";
import { expectedLabRuntimeRoot, ownerKey, resolveOwner } from "./state";
import type { StateRoots } from "./state";
import type { LabMetadata, PersistedLabRuntime } from "./records";

const LAB_STATES = new Set(["provisioning", "ready", "failed", "destroying"]);
const FINDING_SURFACES = new Set([
  "host-bind", "socket-bind", "privileged", "host-namespace", "device", "capability",
  "secret", "config", "fixed-port", "non-loopback-port",
]);

export function assertLabMetadata(
  value: unknown,
  roots: StateRoots,
  owner: string,
  labId: string,
): asserts value is LabMetadata {
  try {
    safeStateName(labId, "lab id");
    resolveOwner(owner, {});
    if (!isRecord(value) || value.version !== 1 || value.id !== labId || value.owner !== owner ||
        value.ownerKey !== ownerKey(owner)) throw new Error("identity mismatch");
    normalizeSecretEnvironment(value);
    if (typeof value.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.name)) throw new Error("invalid name");
    if (typeof value.repoHash !== "string" || !/^[a-f0-9]{12}$/.test(value.repoHash)) throw new Error("invalid repository hash");
    if (typeof value.composeProject !== "string" || !/^ccl-[a-z0-9][a-z0-9-]{0,62}$/.test(value.composeProject)) throw new Error("invalid Compose project");
    if (typeof value.state !== "string" || !LAB_STATES.has(value.state)) throw new Error("invalid lifecycle state");
    const expectedRuntime = expectedLabRuntimeRoot(roots, owner, labId);
    if (!isNormalizedAbsolute(value.runtimeRoot) || value.runtimeRoot !== expectedRuntime) throw new Error("invalid runtime root");
    if (value.workspace !== join(expectedRuntime, "workspace")) throw new Error("invalid workspace root");
    if (!isNormalizedAbsolute(value.sourceRoot) || value.sourceRoot === parse(value.sourceRoot).root) throw new Error("invalid source root");
    if (value.manifestPath !== join(value.sourceRoot, manifestName)) throw new Error("invalid source manifest relationship");
    if (typeof value.commandService !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.commandService)) {
      throw new Error("invalid command service");
    }
    if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) throw new Error("invalid timestamps");
    // Missing fields are legacy state and are retained until a successful
    // authenticated operation refreshes the lease. A malformed string is also
    // retained for the fail-closed reaper to report, rather than expiring it.
    if (value.lastActivityAt !== undefined &&
        (typeof value.lastActivityAt !== "string" || !isBoundedString(value.lastActivityAt, 256))) {
      throw new Error("invalid activity lease");
    }
    if (!Array.isArray(value.endpoints) || !value.endpoints.every(isEndpoint)) throw new Error("invalid endpoints");
    if (!Array.isArray(value.findings) || !value.findings.every(isFinding)) throw new Error("invalid findings");
    if (!isEnvironmentNames(value.secretEnvironment)) throw new Error("invalid secret environment metadata");
    if (value.modeKind !== undefined && value.modeKind !== "compose" && value.modeKind !== "dockerfile" && value.modeKind !== "image") {
      throw new Error("invalid mode kind");
    }
    if (value.error !== undefined && !isBoundedString(value.error, 4_000)) throw new Error("invalid error");
    if (value.provisioningFailure !== undefined) {
      validateProvisioningFailure(value.provisioningFailure);
      if (value.state !== "provisioning" && value.state !== "failed") {
        throw new Error("provisioning failure requires provisioning or failed state");
      }
    }
    if (value.runtime !== undefined) validatePersistedRuntime(value, value.runtime);
    if (value.state === "ready" && value.runtime === undefined) throw new Error("ready lab has no runtime");
    if (value.modeKind === "dockerfile") {
      if (value.managedImage !== internalImageTag(value.ownerKey, value.id)) throw new Error("invalid managed image");
    } else if (value.managedImage !== undefined) {
      throw new Error("unexpected managed image");
    }
  } catch (error) {
    throw new Error(`invalid lab manifest: ${labId}: ${message(error)}`);
  }
}

function validateProvisioningFailure(value: unknown): void {
  if (!isRecord(value) || value.phase !== "compose-up" || !isTimestamp(value.capturedAt) ||
      !Array.isArray(value.services) || value.services.length > 16 ||
      typeof value.serviceCount !== "number" || !Number.isInteger(value.serviceCount) ||
      value.serviceCount < value.services.length || value.serviceCount > 1_000) {
    throw new Error("invalid provisioning failure diagnostic");
  }
  if (!value.services.every(isProvisioningService)) throw new Error("invalid provisioning failure services");
  if (value.evidence !== undefined && !isProvisioningEvidence(value.evidence)) {
    throw new Error("invalid provisioning failure evidence");
  }
}

function isProvisioningService(value: unknown): boolean {
  return isRecord(value) && typeof value.service === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.service) &&
    typeof value.state === "string" && isSafeDiagnosticText(value.state, 64) &&
    (value.health === undefined || (typeof value.health === "string" && isSafeDiagnosticText(value.health, 64))) &&
    (value.exitCode === undefined || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode) && value.exitCode >= -1 && value.exitCode <= 255));
}

function isProvisioningEvidence(value: unknown): boolean {
  return isRecord(value) && value.kind === "compose-up" && typeof value.available === "boolean" &&
    typeof value.bytes === "number" && Number.isInteger(value.bytes) && value.bytes >= 0 && value.bytes <= 8 * 1024 &&
    typeof value.lines === "number" && Number.isInteger(value.lines) && value.lines >= 0 && value.lines <= 500 &&
    typeof value.truncated === "boolean";
}

function isSafeDiagnosticText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function validatePersistedRuntime(lab: Record<string, unknown>, runtime: unknown): asserts runtime is PersistedLabRuntime {
  if (!isRecord(runtime) || !isRecord(runtime.config)) throw new Error("invalid persisted runtime");
  const config = runtime.config;
  if (config.repoRoot !== lab.sourceRoot || config.manifestPath !== lab.manifestPath || !isRecord(config.mode) || !isRecord(config.runtime)) {
    throw new Error("runtime source identity mismatch");
  }
  const mode = config.mode;
    if (mode.kind !== lab.modeKind || mode.commandService !== lab.commandService ||
        typeof mode.commandService !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(mode.commandService)) {
    throw new Error("runtime mode identity mismatch");
  }
  if (mode.kind === "compose") {
    if (!Array.isArray(mode.files) || mode.files.length === 0 || !mode.files.every((path) => isPathInside(lab.sourceRoot as string, path))) {
      throw new Error("invalid Compose source files");
    }
  } else if (mode.kind === "dockerfile") {
    if (!isPathInside(lab.sourceRoot as string, mode.dockerfile) || !isPathInside(lab.sourceRoot as string, mode.context, true)) {
      throw new Error("invalid Dockerfile source paths");
    }
  } else if (mode.kind === "image") {
    if (!isBoundedString(mode.image, 1_024) || mode.image.includes("\0") || mode.image.trim() !== mode.image) throw new Error("invalid image name");
  } else {
    throw new Error("invalid runtime mode");
  }
  if (!isBoundedString(config.runtime.workspace, 1_024) || !posix.isAbsolute(config.runtime.workspace) ||
      posix.normalize(config.runtime.workspace) !== config.runtime.workspace || config.runtime.workspace === "/" ||
      !Array.isArray(config.runtime.shell) || config.runtime.shell.length === 0 || config.runtime.shell.length > 64 ||
      !config.runtime.shell.every((part) => isBoundedString(part, 4_096) && !part.includes("\0")) ||
      !posix.isAbsolute(config.runtime.shell[0]) || posix.normalize(config.runtime.shell[0]) !== config.runtime.shell[0]) throw new Error("invalid container runtime");
  if (!Array.isArray(config.ports) || !config.ports.every(isDeclaredPort)) throw new Error("invalid declared ports");
  if (!Array.isArray(config.forwardEnvironment) || config.forwardEnvironment.length > 64 ||
      !config.forwardEnvironment.every((key) => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
      new Set(config.forwardEnvironment).size !== config.forwardEnvironment.length) {
    throw new Error("invalid forwarded environment");
  }
  const forwardedEnvironment = new Set(config.forwardEnvironment as string[]);
  if (!isEnvironmentNames(config.secretEnvironment) ||
      config.secretEnvironment.some((key) => forwardedEnvironment.has(key))) {
    throw new Error("invalid secret environment");
  }
  if (JSON.stringify(config.secretEnvironment) !== JSON.stringify(lab.secretEnvironment)) {
    throw new Error("secret environment metadata mismatch");
  }
  const runtimeRoot = lab.runtimeRoot as string;
  const expectedOverride = join(runtimeRoot, "override.compose.yaml");
  const expectedBase = mode.kind === "compose" ? undefined : join(runtimeRoot, "base.compose.yaml");
  if (runtime.overrideFile !== expectedOverride || runtime.baseFile !== expectedBase ||
      !Array.isArray(runtime.findings) || !runtime.findings.every(isFinding) ||
      JSON.stringify(runtime.findings) !== JSON.stringify(lab.findings)) throw new Error("invalid runtime files or findings");
  const expectedArgs = composeCommandArgs(config as never, {
    projectName: lab.composeProject as string,
    overrideFile: expectedOverride,
    baseFile: expectedBase,
  });
  if (!Array.isArray(runtime.composeArgs) || runtime.composeArgs.length !== expectedArgs.length ||
      !runtime.composeArgs.every((arg, index) => arg === expectedArgs[index])) throw new Error("invalid Compose arguments");
}

function normalizeSecretEnvironment(lab: Record<string, unknown>): void {
  let runtimeNames: unknown;
  if (isRecord(lab.runtime) && isRecord(lab.runtime.config)) {
    if (lab.runtime.config.secretEnvironment === undefined) lab.runtime.config.secretEnvironment = [];
    runtimeNames = lab.runtime.config.secretEnvironment;
  }
  if (lab.secretEnvironment === undefined) {
    lab.secretEnvironment = Array.isArray(runtimeNames) ? [...runtimeNames] : [];
  }
}

function isEnvironmentNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 &&
    value.every((key) => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) &&
    new Set(value).size === value.length;
}

function isPathInside(root: string, candidate: unknown, allowRoot = false): boolean {
  if (typeof candidate !== "string" || !isNormalizedAbsolute(candidate)) return false;
  const fromRoot = relative(root, candidate);
  return (allowRoot || fromRoot !== "") && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function isNormalizedAbsolute(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

function isEndpoint(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.name) &&
    typeof value.service === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.service) &&
    typeof value.target === "number" && Number.isInteger(value.target) && value.target >= 1 && value.target <= 65_535 && isBoundedString(value.url, 2_048);
}

function isDeclaredPort(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.name) &&
    typeof value.service === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.service) &&
    typeof value.target === "number" && Number.isInteger(value.target) && value.target >= 1 && value.target <= 65_535 &&
    (value.scheme === undefined || (typeof value.scheme === "string" && /^[a-z][a-z0-9+.-]*$/.test(value.scheme)));
}

function isFinding(value: unknown): boolean {
  return isRecord(value) && (value.service === undefined || isBoundedString(value.service, 128)) &&
    typeof value.surface === "string" && FINDING_SURFACES.has(value.surface) && isBoundedString(value.detail, 1_024);
}

export async function realDirectory(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return await realpath(path);
}

export async function realFileInside(root: string, path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a real file`);
  assertCanonicalInside(root, await realpath(path), label, false);
}

export async function realDirectoryInside(root: string, path: string, label: string): Promise<void> {
  const canonical = await realDirectory(path, label);
  assertCanonicalInside(root, canonical, label, true);
}

function assertCanonicalInside(root: string, candidate: string, label: string, allowRoot: boolean): void {
  const fromRoot = relative(root, candidate);
  if ((!allowRoot && fromRoot === "") || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} resolves outside its trusted root`);
  }
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
