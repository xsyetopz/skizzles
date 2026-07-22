import { isAbsolute } from "node:path";
import { types } from "node:util";
import type {
  TaskWorktreeApprovalAuthorityRequest,
  TaskWorktreeConfig,
} from "../../contract.ts";
import type { DependencyResolutionRequest } from "../../dependency/resolution.ts";
import type { DiffCeilings } from "../../diff/contract.ts";
import type { SandboxAuthorityExecutionRequest } from "../../sandbox/capabilities.ts";
import { authorizeStructuredCommand } from "../../sandbox/command-policy.ts";
import { parseProtectedPaths } from "./protection.ts";
import { parseVerificationProfiles } from "./verification.ts";

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const pathSegmentPattern = /^(?!\.\.?$)[^/\0]+$/u;

export function parseConfig(input: unknown): TaskWorktreeConfig | undefined {
  const values = exactRecord(input, [
    "approvalAuthority",
    "authorityId",
    "commandProfiles",
    "commitPolicy",
    "dependencyRequests",
    "dependencyResolver",
    "diffCeilings",
    "repositoryId",
    "repositoryRoot",
    "rootIdentity",
    "protectedPaths",
    "sandbox",
    "sandboxWritePaths",
    "worktreeParent",
    "verificationProfiles",
  ]);
  if (values === undefined || !Object.isFrozen(input)) return;
  const authorityId = values.get("authorityId");
  const approval = parseCallbackConfig(
    values.get("approvalAuthority"),
    "authorize",
  );
  const repositoryRoot = values.get("repositoryRoot");
  const worktreeParent = values.get("worktreeParent");
  const repositoryId = values.get("repositoryId");
  const rootIdentity = values.get("rootIdentity");
  const protectedPaths = parseProtectedPaths(values.get("protectedPaths"));
  const diffCeilings = parseDiffCeilings(values.get("diffCeilings"));
  const commitPolicy = parseCommitPolicy(values.get("commitPolicy"));
  const sandbox = parseSandboxConfig(values.get("sandbox"));
  const sandboxWritePaths = parseStringPaths(values.get("sandboxWritePaths"));
  const resolver = parseCallbackConfig(
    values.get("dependencyResolver"),
    "resolve",
  );
  const dependencyRequests = parseDependencyRequests(
    values.get("dependencyRequests"),
  );
  const commandProfiles = parseCommandProfiles(values.get("commandProfiles"));
  const verificationProfiles = parseVerificationProfiles(
    values.get("verificationProfiles"),
  );
  if (
    !(
      identity(authorityId) &&
      absolutePath(repositoryRoot) &&
      absolutePath(worktreeParent) &&
      identity(repositoryId) &&
      identity(rootIdentity)
    ) ||
    diffCeilings === undefined ||
    approval === undefined ||
    commitPolicy === undefined ||
    sandbox === undefined ||
    sandboxWritePaths === undefined ||
    resolver === undefined ||
    dependencyRequests === undefined ||
    commandProfiles === undefined ||
    protectedPaths === undefined ||
    verificationProfiles === undefined ||
    (verificationProfiles.length > 0 && protectedPaths.testRoots.length === 0)
  ) {
    return;
  }
  return Object.freeze({
    authorityId,
    repositoryRoot,
    worktreeParent,
    repositoryId,
    rootIdentity,
    protectedPaths,
    approvalAuthority: Object.freeze({
      id: approval.id,
      authorize: async (request: TaskWorktreeApprovalAuthorityRequest) =>
        await Reflect.apply(approval.callback, undefined, [request]),
    }),
    diffCeilings,
    commitPolicy,
    sandbox: Object.freeze({
      id: sandbox.id,
      attest: async (paths: readonly string[]) =>
        await Reflect.apply(sandbox.callback, undefined, [paths]),
      execute: async (request: SandboxAuthorityExecutionRequest) =>
        await Reflect.apply(sandbox.execute, undefined, [request]),
    }),
    sandboxWritePaths,
    dependencyResolver: Object.freeze({
      id: resolver.id,
      resolve: async (request: DependencyResolutionRequest) =>
        await Reflect.apply(resolver.callback, undefined, [request]),
    }),
    dependencyRequests,
    commandProfiles,
    verificationProfiles,
  });
}

function parseSandboxConfig(value: unknown):
  | Readonly<{
      id: string;
      callback: (...arguments_: unknown[]) => unknown;
      execute: (...arguments_: unknown[]) => unknown;
    }>
  | undefined {
  const record = exactRecord(value, ["attest", "execute", "id"]);
  const id = record?.get("id");
  const attest = record?.get("attest");
  const execute = record?.get("execute");
  if (
    record === undefined ||
    !Object.isFrozen(value) ||
    !identity(id) ||
    typeof attest !== "function" ||
    typeof execute !== "function"
  )
    return;
  return Object.freeze({
    id,
    callback: (...arguments_: unknown[]) =>
      Reflect.apply(attest, undefined, arguments_),
    execute: (...arguments_: unknown[]) =>
      Reflect.apply(execute, undefined, arguments_),
  });
}

function parseStringPaths(value: unknown): readonly string[] | undefined {
  if (!(Array.isArray(value) && Object.isFrozen(value)) || value.length === 0)
    return;
  const paths: string[] = [];
  for (const path of value) {
    if (typeof path !== "string" || !relativePath(path) || paths.includes(path))
      return;
    paths.push(path);
  }
  return Object.freeze(paths.sort((left, right) => (left < right ? -1 : 1)));
}

function parseDiffCeilings(value: unknown): DiffCeilings | undefined {
  const record = exactRecord(value, [
    "maxAddedLines",
    "maxChangedBytes",
    "maxChangedFiles",
    "maxDeletedLines",
  ]);
  if (record === undefined || !Object.isFrozen(value)) return;
  const maxChangedFiles = positiveInteger(
    record.get("maxChangedFiles"),
    10_000,
  );
  const maxAddedLines = positiveInteger(
    record.get("maxAddedLines"),
    10_000_000,
  );
  const maxDeletedLines = positiveInteger(
    record.get("maxDeletedLines"),
    10_000_000,
  );
  const maxChangedBytes = positiveInteger(
    record.get("maxChangedBytes"),
    1024 * 1024 * 1024,
  );
  if (
    [maxChangedFiles, maxAddedLines, maxDeletedLines, maxChangedBytes].some(
      (entry) => entry === undefined,
    )
  )
    return;
  return Object.freeze({
    maxChangedFiles: maxChangedFiles ?? 0,
    maxAddedLines: maxAddedLines ?? 0,
    maxDeletedLines: maxDeletedLines ?? 0,
    maxChangedBytes: maxChangedBytes ?? 0,
  });
}

function parseCommitPolicy(
  value: unknown,
): TaskWorktreeConfig["commitPolicy"] | undefined {
  const record = exactRecord(value, ["maxSubjectLength", "ownedPackagePaths"]);
  const maxSubjectLength = positiveInteger(
    record?.get("maxSubjectLength"),
    120,
  );
  const rawPaths = record?.get("ownedPackagePaths");
  if (
    record === undefined ||
    !Object.isFrozen(value) ||
    maxSubjectLength === undefined ||
    !Array.isArray(rawPaths) ||
    !Object.isFrozen(rawPaths)
  )
    return;
  const paths: { path: string; scope: string }[] = [];
  for (const raw of rawPaths) {
    const item = exactRecord(raw, ["path", "scope"]);
    const path = item?.get("path");
    const scope = item?.get("scope");
    if (
      item === undefined ||
      !Object.isFrozen(raw) ||
      typeof path !== "string" ||
      !relativePath(path) ||
      typeof scope !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(scope)
    )
      return;
    paths.push(Object.freeze({ path, scope }));
  }
  return Object.freeze({
    maxSubjectLength,
    ownedPackagePaths: Object.freeze(paths),
  });
}

function parseCallbackConfig(
  value: unknown,
  key: "attest" | "authorize" | "resolve",
):
  | Readonly<{
      id: string;
      callback: (...arguments_: unknown[]) => unknown;
    }>
  | undefined {
  const record = exactRecord(value, [key, "id"]);
  const id = record?.get("id");
  const callback = record?.get(key);
  if (
    !(
      record !== undefined &&
      Object.isFrozen(value) &&
      identity(id) &&
      typeof callback === "function"
    )
  )
    return;
  return Object.freeze({
    id,
    callback: (...arguments_: unknown[]) =>
      Reflect.apply(callback, undefined, arguments_),
  });
}

function parseDependencyRequests(
  value: unknown,
): readonly DependencyResolutionRequest[] | undefined {
  if (!(Array.isArray(value) && Object.isFrozen(value)) || value.length > 256)
    return;
  const requests: DependencyResolutionRequest[] = [];
  for (const raw of value) {
    const record = exactRecord(raw, ["ecosystem", "name", "requestedRange"]);
    const name = record?.get("name");
    const requestedRange = record?.get("requestedRange");
    if (
      record === undefined ||
      !Object.isFrozen(raw) ||
      record.get("ecosystem") !== "npm" ||
      typeof name !== "string" ||
      typeof requestedRange !== "string"
    )
      return;
    requests.push(Object.freeze({ ecosystem: "npm", name, requestedRange }));
  }
  return Object.freeze(requests);
}

function parseCommandProfiles(
  value: unknown,
): TaskWorktreeConfig["commandProfiles"] | undefined {
  if (!(Array.isArray(value) && Object.isFrozen(value)) || value.length > 64)
    return;
  const profiles: TaskWorktreeConfig["commandProfiles"][number][] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const record = exactRecord(raw, [
      "arguments",
      "cwd",
      "drainMilliseconds",
      "executable",
      "id",
      "maximumOutputBytes",
      "profile",
      "signalGraceMilliseconds",
      "timeoutMilliseconds",
    ]);
    const id = record?.get("id");
    const command =
      record === undefined
        ? undefined
        : authorizeStructuredCommand(
            Object.freeze({
              profile: record.get("profile"),
              executable: record.get("executable"),
              arguments: record.get("arguments"),
              cwd: record.get("cwd"),
            }),
          );
    const timeoutMilliseconds = positiveInteger(
      record?.get("timeoutMilliseconds"),
      3_600_000,
    );
    const maximumOutputBytes = positiveInteger(
      record?.get("maximumOutputBytes"),
      64 * 1024 * 1024,
    );
    const drainMilliseconds = nonnegativeInteger(
      record?.get("drainMilliseconds"),
      60_000,
    );
    const signalGraceMilliseconds = nonnegativeInteger(
      record?.get("signalGraceMilliseconds"),
      60_000,
    );
    if (
      record === undefined ||
      !Object.isFrozen(raw) ||
      !identity(id) ||
      ids.has(id) ||
      command?.status !== "accepted" ||
      timeoutMilliseconds === undefined ||
      maximumOutputBytes === undefined ||
      drainMilliseconds === undefined ||
      signalGraceMilliseconds === undefined
    )
      return;
    ids.add(id);
    profiles.push(
      Object.freeze({
        id,
        ...command.command,
        timeoutMilliseconds,
        maximumOutputBytes,
        drainMilliseconds,
        signalGraceMilliseconds,
      }),
    );
  }
  return Object.freeze(profiles);
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
    ? value
    : undefined;
}

function nonnegativeInteger(
  value: unknown,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : undefined;
}
function exactRecord(
  input: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    Reflect.ownKeys(input).length !== keys.length
  ) {
    return;
  }
  const values = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    values.set(key, descriptor.value);
  }
  return values;
}

function absolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    !value.includes("\0") &&
    value.length <= 4096
  );
}

function identity(value: unknown): value is string {
  return typeof value === "string" && identityPattern.test(value);
}

function relativePath(value: string): boolean {
  return (
    value.length <= 4096 &&
    value.split("/").every((segment) => pathSegmentPattern.test(segment))
  );
}
