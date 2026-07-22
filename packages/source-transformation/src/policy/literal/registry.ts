import { posix } from "node:path";
import { types } from "node:util";
import { type Digest, digestText } from "../../digest.ts";
import type {
  LiteralRegistrationReceipt,
  LiteralRegistrationResult,
  LiteralRegistry,
  LiteralRegistryCreationResult,
  LiteralRegistrySnapshot,
  LiteralRegistrySnapshotRecovery,
  LiteralSyntaxExemption,
  RegisteredLiteralEntry,
  RegisteredLiteralValue,
} from "./contract.ts";

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z\d_$]{0,127}$/u;
const REGISTRY_ID_PATTERN = /^[A-Za-z\d][A-Za-z\d._:-]{0,127}$/u;
const MAXIMUM_ENTRIES = 1024;
const SYNTAX_EXEMPTIONS: readonly LiteralSyntaxExemption[] = Object.freeze([
  "collection-index",
  "diagnostic-message",
  "discriminant-tag",
  "module-specifier",
  "structural-number",
]);

interface RegistryState {
  readonly registryId: string;
  readonly registryPath: string;
  readonly exportName: string;
  readonly entries: Map<string, RegisteredLiteralEntry>;
  readonly valueKeys: Set<string>;
  revision: number;
  registryDigest: Digest;
}

interface SnapshotState {
  readonly registryPath: string;
  readonly exportName: string;
  readonly entriesByKey: ReadonlyMap<string, RegisteredLiteralEntry>;
}

const registries = new WeakMap<object, RegistryState>();
const receipts = new WeakSet<object>();
const snapshots = new WeakMap<object, SnapshotState>();

export function createLiteralRegistry(
  input: unknown,
): LiteralRegistryCreationResult {
  try {
    const config = parseConfig(input);
    if (config === undefined) return rejectedConfig();
    const state: RegistryState = {
      ...config,
      entries: new Map(),
      valueKeys: new Set(),
      revision: 0,
      registryDigest: registryDigest(config, 0, []),
    };
    const registry: LiteralRegistry = Object.freeze({
      register: (value: unknown) => registerLiteral(state, value),
      snapshot: () => createSnapshot(state),
    });
    registries.set(registry, state);
    return Object.freeze({ status: "created", registry });
  } catch {
    return rejectedConfig();
  }
}

export function isLiteralRegistry(value: unknown): value is LiteralRegistry {
  return isPlainObject(value) && registries.has(value);
}

export function isLiteralRegistrySnapshot(
  value: unknown,
): value is LiteralRegistrySnapshot {
  return isPlainObject(value) && snapshots.has(value);
}

export function isLiteralRegistrationReceipt(
  value: unknown,
): value is LiteralRegistrationReceipt {
  return isPlainObject(value) && receipts.has(value);
}

export function recoverLiteralRegistrySnapshot(
  value: unknown,
): LiteralRegistrySnapshotRecovery {
  if (!isLiteralRegistrySnapshot(value)) {
    return Object.freeze({
      status: "rejected",
      code: "FORGED_LITERAL_REGISTRY_SNAPSHOT",
    });
  }
  const state = snapshots.get(value);
  if (state === undefined) {
    return Object.freeze({
      status: "rejected",
      code: "FORGED_LITERAL_REGISTRY_SNAPSHOT",
    });
  }
  return Object.freeze({
    status: "recovered",
    registryPath: state.registryPath,
    exportName: state.exportName,
    entriesByKey: new Map(state.entriesByKey),
  });
}

function registerLiteral(
  state: RegistryState,
  input: unknown,
): LiteralRegistrationResult {
  try {
    const parsed = parseRegistration(input);
    if (parsed === undefined) return rejectedRegistration();
    if (state.entries.has(parsed.key)) {
      return Object.freeze({
        status: "rejected",
        code: "DUPLICATE_LITERAL_KEY",
      });
    }
    const valueKey = literalKey(parsed.value);
    if (state.valueKeys.has(valueKey)) {
      return Object.freeze({
        status: "rejected",
        code: "DUPLICATE_LITERAL_VALUE",
      });
    }
    if (state.entries.size >= MAXIMUM_ENTRIES) {
      return Object.freeze({
        status: "rejected",
        code: "LITERAL_REGISTRY_CAPACITY_EXCEEDED",
      });
    }

    const previousRegistryDigest = state.registryDigest;
    const revision = state.revision + 1;
    const registrationDigest = digestText(
      JSON.stringify([
        state.registryId,
        state.registryPath,
        state.exportName,
        parsed.key,
        typeof parsed.value,
        parsed.value,
        parsed.description,
      ]),
    );
    const entry: RegisteredLiteralEntry = Object.freeze({
      key: parsed.key,
      kind: typeof parsed.value === "string" ? "string" : "number",
      value: parsed.value,
      description: parsed.description,
      registrationDigest,
    });
    const nextEntries = [...state.entries.values(), entry].sort(compareEntries);
    const nextRegistryDigest = registryDigest(state, revision, nextEntries);
    const propertySource = `${parsed.key}: ${renderLiteral(parsed.value)},`;
    const receiptMaterial = {
      registryId: state.registryId,
      registryPath: state.registryPath,
      exportName: state.exportName,
      revision,
      previousRegistryDigest,
      registryDigest: nextRegistryDigest,
      key: entry.key,
      kind: entry.kind,
      value: entry.value,
      description: entry.description,
      registrationDigest,
      propertySource,
    };
    const receipt: LiteralRegistrationReceipt = Object.freeze({
      ...receiptMaterial,
      receiptDigest: digestText(JSON.stringify(receiptMaterial)),
    });
    receipts.add(receipt);

    state.entries.set(entry.key, entry);
    state.valueKeys.add(valueKey);
    state.revision = revision;
    state.registryDigest = nextRegistryDigest;
    return Object.freeze({
      status: "registered",
      receipt,
      snapshot: createSnapshot(state),
    });
  } catch {
    return rejectedRegistration();
  }
}

function createSnapshot(state: RegistryState): LiteralRegistrySnapshot {
  const entries = Object.freeze(
    [...state.entries.values()].sort(compareEntries),
  );
  const snapshot: LiteralRegistrySnapshot = Object.freeze({
    registryId: state.registryId,
    registryPath: state.registryPath,
    exportName: state.exportName,
    revision: state.revision,
    entries,
    syntaxExemptions: SYNTAX_EXEMPTIONS,
    registryDigest: state.registryDigest,
  });
  snapshots.set(
    snapshot,
    Object.freeze({
      registryPath: state.registryPath,
      exportName: state.exportName,
      entriesByKey: new Map(entries.map((entry) => [entry.key, entry])),
    }),
  );
  return snapshot;
}

function parseConfig(value: unknown):
  | Readonly<{
      registryId: string;
      registryPath: string;
      exportName: string;
    }>
  | undefined {
  const record = exactFrozenRecord(value, [
    "registryId",
    "registryPath",
    "exportName",
  ]);
  const registryId = record?.get("registryId");
  const registryPath = record?.get("registryPath");
  const exportName = record?.get("exportName");
  if (
    typeof registryId !== "string" ||
    !REGISTRY_ID_PATTERN.test(registryId) ||
    !isSourcePath(registryPath) ||
    typeof exportName !== "string" ||
    !IDENTIFIER_PATTERN.test(exportName)
  ) {
    return;
  }
  return Object.freeze({ registryId, registryPath, exportName });
}

function parseRegistration(value: unknown):
  | Readonly<{
      key: string;
      value: RegisteredLiteralValue;
      description: string;
    }>
  | undefined {
  const record = exactFrozenRecord(value, ["key", "value", "description"]);
  const key = record?.get("key");
  const literalValue = record?.get("value");
  const description = record?.get("description");
  if (
    typeof key !== "string" ||
    !IDENTIFIER_PATTERN.test(key) ||
    !isLiteralValue(literalValue) ||
    typeof description !== "string" ||
    description.length === 0 ||
    description.length > 512 ||
    description.includes("\0")
  ) {
    return;
  }
  return Object.freeze({ key, value: literalValue, description });
}

function registryDigest(
  identity: Readonly<{
    registryId: string;
    registryPath: string;
    exportName: string;
  }>,
  revision: number,
  entries: readonly RegisteredLiteralEntry[],
): Digest {
  return digestText(
    JSON.stringify({
      registryId: identity.registryId,
      registryPath: identity.registryPath,
      exportName: identity.exportName,
      revision,
      syntaxExemptions: SYNTAX_EXEMPTIONS,
      entries,
    }),
  );
}

function exactFrozenRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (!isPlainObject(value) || !Object.isFrozen(value)) return;
  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return;
    }
    result.set(key, descriptor.value);
  }
  if (result.size !== keys.length || !keys.every((key) => result.has(key))) {
    return;
  }
  return result;
}

function isPlainObject(value: unknown): value is object {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSourcePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    return false;
  }
  const normalized = posix.normalize(value);
  return (
    normalized === value &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    /\.(?:cts|mts|ts|tsx)$/u.test(value)
  );
}

function isLiteralValue(value: unknown): value is RegisteredLiteralValue {
  if (typeof value === "string") {
    return value.length > 0 && value.length <= 4096 && !value.includes("\0");
  }
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value)
  );
}

function literalKey(value: RegisteredLiteralValue): string {
  return `${typeof value}:${String(value)}`;
}

function renderLiteral(value: RegisteredLiteralValue): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function compareEntries(
  left: RegisteredLiteralEntry,
  right: RegisteredLiteralEntry,
): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function rejectedConfig(): LiteralRegistryCreationResult {
  return Object.freeze({
    status: "rejected",
    code: "INVALID_LITERAL_REGISTRY_CONFIG",
  });
}

function rejectedRegistration(): LiteralRegistrationResult {
  return Object.freeze({
    status: "rejected",
    code: "INVALID_LITERAL_REGISTRATION",
  });
}
