import { types } from "node:util";
import { digestValue } from "../digest.ts";
import type {
  ConfigurationDefinition,
  ConfigurationValue,
} from "./contracts.ts";

export function safePath(path: string): boolean {
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

export function isConfigPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    path.startsWith("config/") ||
    basename.endsWith(".json") ||
    basename.endsWith(".yaml") ||
    basename.endsWith(".yml") ||
    basename.endsWith(".toml") ||
    basename.endsWith(".ini")
  );
}

export function validKind(
  kind: unknown,
): kind is ConfigurationDefinition["kind"] {
  return (
    kind === "string" ||
    kind === "number" ||
    kind === "boolean" ||
    kind === "json"
  );
}

export function dataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor !== undefined && "value" in descriptor)
    return descriptor.value;
}

export function canonicalValue(value: ConfigurationValue): ConfigurationValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    const output: Record<string, ConfigurationValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = dataValue(value, key);
      output[key] = validValue(child) ? canonicalValue(child) : null;
    }
    return output;
  }
  return value;
}

export function validValue(value: unknown): value is ConfigurationValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validValue);
  if (typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).every((key) => validValue(dataValue(value, key)));
}

export function kindMatches(
  kind: ConfigurationDefinition["kind"],
  value: ConfigurationValue,
): boolean {
  if (kind === "json") return true;
  return (
    (kind === "string" && typeof value === "string") ||
    (kind === "number" && typeof value === "number") ||
    (kind === "boolean" && typeof value === "boolean")
  );
}

export function registryDigest(
  definitions: readonly ConfigurationDefinition[],
  values: ReadonlyMap<string, ConfigurationValue>,
): ReturnType<typeof digestValue> {
  return digestValue({
    definitions,
    values: [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, canonicalValue(value)]),
  });
}

export function freezeDefinition(
  definition: ConfigurationDefinition,
): ConfigurationDefinition {
  return Object.freeze({ ...definition });
}
