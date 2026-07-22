import { types } from "node:util";
import type { ConfigurationWriteReceipt } from "../configuration/contracts.ts";
import { isConfigurationWriteReceipt } from "../configuration/registry.ts";
import type {
  ChangeAssuranceExtension,
  ChangeAssuranceExtensionConfig,
  ChangeAssuranceExtensionCreationResult,
  ChangeAssuranceExtensionInput,
  ChangeAssuranceExtensionResult,
} from "../contract.ts";
import { digestValue } from "../digest.ts";
import {
  createChangeAssuranceExtension,
  isChangeAssuranceExtension,
} from "../extension.ts";
import { createSecretScanner } from "../security/secrets/scanner.ts";
import type { MigrationPhase, MigrationSource } from "./contracts.ts";
import { createMigrationLinter } from "./linter.ts";

export type MigrationConfigurationSecretsExtensionConfig = {
  readonly id: string;
  readonly version: string;
  readonly configurationPaths: readonly string[];
  readonly authorizedConfigurationWrites?: readonly ConfigurationWriteReceipt[];
};

export type MigrationConfigurationSecretsExtensionCreationResult =
  ChangeAssuranceExtensionCreationResult;

function isMigrationPhase(value: unknown): value is MigrationPhase {
  return value === "schema" || value === "backfill" || value === "rollback";
}

function dataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}

function parseConfig(
  input: unknown,
): MigrationConfigurationSecretsExtensionConfig | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input)
  )
    return;
  const id = dataValue(input, "id");
  const version = dataValue(input, "version");
  const paths = dataValue(input, "configurationPaths");
  const writes = dataValue(input, "authorizedConfigurationWrites");
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 128 ||
    typeof version !== "string" ||
    version.length === 0 ||
    version.length > 64 ||
    !Array.isArray(paths) ||
    !paths.every((path) => typeof path === "string" && safePath(path))
  )
    return;
  if (
    writes !== undefined &&
    !(
      Array.isArray(writes) &&
      writes.every((receipt) => isConfigurationWriteReceipt(receipt))
    )
  )
    return;
  const configurationPaths = Object.freeze(
    [...new Set(paths)].sort((left, right) => left.localeCompare(right)),
  );
  const authorizedConfigurationWrites =
    writes === undefined ? undefined : Object.freeze([...writes]);
  return Object.freeze({
    id,
    version,
    configurationPaths,
    ...(authorizedConfigurationWrites === undefined
      ? {}
      : { authorizedConfigurationWrites }),
  });
}

function targetBytes(
  input: ChangeAssuranceExtensionInput,
):
  | readonly { readonly path: string; readonly bytes: Uint8Array }[]
  | undefined {
  const candidates: { readonly path: string; readonly bytes: Uint8Array }[] =
    [];
  const targets = dataValue(input, "targets");
  if (!Array.isArray(targets)) return;
  const paths = new Set<string>();
  for (const rawTarget of targets) {
    if (
      typeof rawTarget !== "object" ||
      rawTarget === null ||
      Array.isArray(rawTarget) ||
      types.isProxy(rawTarget)
    )
      return;
    const path = dataValue(rawTarget, "path");
    const operation = dataValue(rawTarget, "operation");
    const candidateBytes = dataValue(rawTarget, "candidateBytes");
    if (
      typeof path !== "string" ||
      paths.has(path) ||
      (operation !== "write" && operation !== "delete")
    )
      return;
    paths.add(path);
    if (candidateBytes === null || operation !== "write") continue;
    if (
      !(
        Array.isArray(candidateBytes) &&
        candidateBytes.every(
          (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
        )
      )
    )
      return;
    candidates.push({
      path,
      bytes: Uint8Array.from(candidateBytes),
    });
  }
  return candidates;
}

function parseMigrationPlan(
  plan: unknown,
  candidates: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): readonly MigrationSource[] | undefined {
  if (
    typeof plan !== "object" ||
    plan === null ||
    Array.isArray(plan) ||
    types.isProxy(plan)
  )
    return [];
  const raw = dataValue(plan, "migrations");
  if (raw === undefined) {
    return candidates.some((candidate) =>
      candidate.path.startsWith("src/data/"),
    )
      ? undefined
      : [];
  }
  if (!Array.isArray(raw)) return;
  const byPath = new Map(
    candidates.map((candidate) => [candidate.path, candidate]),
  );
  const sources: MigrationSource[] = [];
  const describedPaths = new Set<string>();
  for (const descriptor of raw) {
    if (
      typeof descriptor !== "object" ||
      descriptor === null ||
      Array.isArray(descriptor) ||
      types.isProxy(descriptor)
    )
      return;
    const path = dataValue(descriptor, "path");
    const phase = dataValue(descriptor, "phase");
    const order = dataValue(descriptor, "order");
    const identity = dataValue(descriptor, "identity");
    const candidate = typeof path === "string" ? byPath.get(path) : undefined;
    if (
      candidate === undefined ||
      typeof path !== "string" ||
      describedPaths.has(path) ||
      typeof order !== "number" ||
      !isMigrationPhase(phase) ||
      (identity !== undefined && typeof identity !== "string")
    )
      return;
    describedPaths.add(path);
    sources.push({
      path,
      phase,
      order,
      bytes: candidate.bytes,
      ...(typeof identity === "string" ? { identity } : {}),
    });
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.path.startsWith("src/data/") &&
        !describedPaths.has(candidate.path),
    )
  )
    return;
  return sources;
}

function createAssessment(
  config: MigrationConfigurationSecretsExtensionConfig,
  input: ChangeAssuranceExtensionInput,
): ChangeAssuranceExtensionResult {
  const candidates = targetBytes(input);
  if (candidates === undefined)
    return { status: "rejected", code: "INVALID_TARGET_BYTES" };
  const migrationSources = parseMigrationPlan(input.plan, candidates);
  if (migrationSources === undefined)
    return { status: "rejected", code: "MIGRATION_PLAN_REQUIRED" };
  const migration =
    migrationSources.length === 0
      ? undefined
      : createMigrationLinter().lint(migrationSources);
  if (migration !== undefined && !migration.ok)
    return { status: "rejected", code: "MIGRATION_REJECTED" };
  const securityInput =
    config.authorizedConfigurationWrites === undefined
      ? { candidates, configurationPaths: config.configurationPaths }
      : {
          candidates,
          configurationPaths: config.configurationPaths,
          authorizedConfigurationWrites: config.authorizedConfigurationWrites,
        };
  const security = createSecretScanner().scan(securityInput);
  if (!security.ok) return { status: "rejected", code: "SECRET_SCAN_REJECTED" };
  return {
    status: "accepted",
    evidenceDigest: digestValue({
      declarationDigest: input.declarationDigest,
      migration: migration?.receipt ?? { accepted: true, empty: true },
      security: security.receipt,
    }),
  };
}

export function createMigrationConfigurationSecretsExtension(
  input: unknown,
): MigrationConfigurationSecretsExtensionCreationResult {
  const parsed = parseConfig(input);
  if (parsed === undefined)
    return { status: "rejected", code: "INVALID_EXTENSION_CONFIG" };
  const config: ChangeAssuranceExtensionConfig = {
    domain: "migration-configuration-secrets",
    id: parsed.id,
    version: parsed.version,
    assess: (assessment) => createAssessment(parsed, assessment),
  };
  return createChangeAssuranceExtension(config);
}

export function isMigrationConfigurationSecretsExtension(
  value: unknown,
): value is ChangeAssuranceExtension {
  return (
    isChangeAssuranceExtension(value) &&
    value.domain === "migration-configuration-secrets"
  );
}
