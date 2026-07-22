import { types } from "node:util";
import { digestBytes, digestValue } from "../digest.ts";
import type {
  ConfigurationDefinition,
  ConfigurationRegistrationInput,
  ConfigurationRegistrationReceipt,
  ConfigurationRegistry,
  ConfigurationRegistryConfig,
  ConfigurationRegistrySnapshot,
  ConfigurationValue,
  ConfigurationWriteReceipt,
} from "./contracts.ts";
import {
  AUTHENTIC_REGISTRIES,
  AUTHENTIC_WRITES,
  createWriteReceipt,
  receiptMatches,
  WRITE_BYTES,
} from "./receipts.ts";
import {
  canonicalValue,
  dataValue,
  freezeDefinition,
  isConfigPath,
  kindMatches,
  registryDigest,
  safePath,
  validKind,
  validValue,
} from "./validation.ts";

export function createConfigurationRegistry(
  config: ConfigurationRegistryConfig,
): ConfigurationRegistry {
  const definitions = [...config.definitions].map(freezeDefinition);
  const seen = new Set<string>();
  const valid =
    definitions.length > 0 &&
    definitions.every((definition) => {
      const accepted =
        safePath(definition.path) &&
        isConfigPath(definition.path) &&
        definition.key.length > 0 &&
        validKind(definition.kind) &&
        !seen.has(definition.key);
      seen.add(definition.key);
      return accepted;
    });
  if (!valid)
    throw new Error(
      "configuration registry definitions must contain unique keys and safe paths",
    );
  const definitionByKey = new Map(
    definitions.map((definition) => [definition.key, definition]),
  );
  const values = new Map<string, ConfigurationValue>();
  const registrations = new Map<string, ConfigurationRegistrationReceipt>();
  const registry: ConfigurationRegistry = {
    register: (input: ConfigurationRegistrationInput) =>
      registerValue(input, definitions, definitionByKey, values, registrations),
    materialize: (input) =>
      materializeValue(
        input,
        registry,
        definitions,
        definitionByKey,
        values,
        registrations,
      ),
    snapshot: () => snapshot(definitions, values, registrations),
  };
  Object.freeze(registry);
  AUTHENTIC_REGISTRIES.add(registry);
  return registry;
}

function registerValue(
  input: ConfigurationRegistrationInput,
  definitions: readonly ConfigurationDefinition[],
  definitionByKey: ReadonlyMap<string, ConfigurationDefinition>,
  values: Map<string, ConfigurationValue>,
  registrations: Map<string, ConfigurationRegistrationReceipt>,
): ReturnType<ConfigurationRegistry["register"]> {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      types.isProxy(input)
    )
      return {
        ok: false,
        code: "INVALID_VALUE",
        message: "configuration key/value is malformed",
      };
    const key = dataValue(input, "key");
    const rawValue = dataValue(input, "value");
    if (typeof key !== "string" || !validValue(rawValue))
      return {
        ok: false,
        code: "INVALID_VALUE",
        message: "configuration key/value is malformed",
      };
    const definition = definitionByKey.get(key);
    if (definition === undefined)
      return {
        ok: false,
        code: "UNKNOWN_KEY",
        message: "configuration key is not registered",
      };
    if (registrations.has(key))
      return {
        ok: false,
        code: "DUPLICATE_KEY",
        message: "configuration key was already registered",
      };
    if (!kindMatches(definition.kind, rawValue))
      return {
        ok: false,
        code: "INVALID_VALUE",
        message: "configuration value does not match its schema",
      };
    const value = canonicalValue(rawValue);
    values.set(key, value);
    const material = {
      key,
      path: definition.path,
      valueDigest: digestValue(value),
      registryDigest: registryDigest(definitions, values),
    };
    const receipt: ConfigurationRegistrationReceipt = Object.freeze({
      ...material,
      receiptDigest: digestValue(material),
    });
    registrations.set(key, receipt);
    return { ok: true, receipt };
  } catch {
    return {
      ok: false,
      code: "INVALID_VALUE",
      message: "configuration registration failed closed",
    };
  }
}

function materializeValue(
  input: { readonly key: string },
  registry: ConfigurationRegistry,
  definitions: readonly ConfigurationDefinition[],
  definitionByKey: ReadonlyMap<string, ConfigurationDefinition>,
  values: ReadonlyMap<string, ConfigurationValue>,
  registrations: ReadonlyMap<string, ConfigurationRegistrationReceipt>,
): ReturnType<ConfigurationRegistry["materialize"]> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input)
  )
    return {
      ok: false,
      code: "UNREGISTERED_KEY",
      message: "configuration key is not registered",
    };
  const key = dataValue(input, "key");
  const definition =
    typeof key === "string" ? definitionByKey.get(key) : undefined;
  if (definition === undefined)
    return {
      ok: false,
      code: "UNREGISTERED_KEY",
      message: "configuration key is not registered",
    };
  const selected = [...definitions]
    .filter(
      (candidate) =>
        candidate.path === definition.path && values.has(candidate.key),
    )
    .sort((left, right) => left.key.localeCompare(right.key));
  if (selected.length === 0 || !safePath(definition.path))
    return {
      ok: false,
      code: "EMPTY_PATH",
      message: "configuration path has no registered value",
    };
  const document: Record<string, ConfigurationValue> = {};
  const selectedRegistrations: ConfigurationRegistrationReceipt[] = [];
  for (const selectedDefinition of selected) {
    const value = values.get(selectedDefinition.key);
    const registration = registrations.get(selectedDefinition.key);
    if (value === undefined || registration === undefined)
      return {
        ok: false,
        code: "EMPTY_PATH",
        message: "configuration registry state is incomplete",
      };
    document[selectedDefinition.key] = canonicalValue(value);
    selectedRegistrations.push(registration);
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(document)}\n`);
  const receipt = createWriteReceipt({
    registry,
    path: definition.path,
    bytes,
    digest: digestBytes(bytes),
    registrations: selectedRegistrations,
  });
  return { ok: true, bytes: new Uint8Array(bytes), receipt };
}

function snapshot(
  definitions: readonly ConfigurationDefinition[],
  values: ReadonlyMap<string, ConfigurationValue>,
  registrations: ReadonlyMap<string, ConfigurationRegistrationReceipt>,
): ConfigurationRegistrySnapshot {
  return Object.freeze({
    definitions: Object.freeze(definitions.map(freezeDefinition)),
    registrations: Object.freeze([...registrations.values()]),
    registryDigest: registryDigest(definitions, values),
  });
}

export function isConfigurationRegistry(
  value: unknown,
): value is ConfigurationRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    AUTHENTIC_REGISTRIES.has(value)
  );
}

export function isConfigurationWriteReceipt(
  value: unknown,
): value is ConfigurationWriteReceipt {
  return (
    typeof value === "object" && value !== null && AUTHENTIC_WRITES.has(value)
  );
}

export function readConfigurationWriteBytes(
  receipt: ConfigurationWriteReceipt,
): Uint8Array | undefined {
  if (!isConfigurationWriteReceipt(receipt)) return;
  const bytes = WRITE_BYTES.get(receipt);
  if (bytes === undefined) return;
  return new Uint8Array(bytes);
}

export function isConfigurationWriteAuthorized(
  receipt: ConfigurationWriteReceipt,
  input: { readonly path: string; readonly bytes: Uint8Array },
): boolean {
  if (
    !isConfigurationWriteReceipt(receipt) ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input)
  )
    return false;
  const path = dataValue(input, "path");
  const bytes = dataValue(input, "bytes");
  if (typeof path !== "string" || !(bytes instanceof Uint8Array)) return false;
  return receiptMatches(receipt, path, bytes);
}
