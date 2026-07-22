import { types } from "node:util";
import { isTypeScriptCompilerAuthority } from "../evidence/compiler.ts";
import type { RegisteredFormatterProfile } from "../evidence/contract.ts";
import type {
  SourceLanguageAdapter,
  SourceLanguageAdapterCreationResult,
  TypeScriptAstLanguage,
  TypeScriptAstLanguageAdapterConfig,
} from "./contract.ts";
import { createTypeScriptLanguageCapability } from "./typescript-capability.ts";
import type {
  SourceLanguageAdapterBindings,
  TypeScriptAstLanguageCapability,
} from "./typescript-contract.ts";

const bindings = new WeakMap<
  SourceLanguageAdapter,
  SourceLanguageAdapterBindings
>();
const languages: ReadonlySet<string> = new Set([
  "javascript",
  "tsx",
  "typescript",
]);

export function createTypeScriptAstLanguageAdapter(
  input: unknown,
): SourceLanguageAdapterCreationResult {
  try {
    const config = parseConfig(input);
    if (config === undefined) return rejected();
    const capability = createTypeScriptLanguageCapability((adapter) =>
      bindings.get(adapter),
    );
    const adapter: TypeScriptAstLanguageCapability = Object.freeze({
      language: config.language,
      parser: "typescript-ast",
      parserVersion: "7.0.2",
      ...capability,
    });
    bindings.set(adapter, Object.freeze({ ...config, adapter }));
    return Object.freeze({ status: "created", adapter });
  } catch {
    return rejected();
  }
}

export function isSourceLanguageAdapter(
  value: unknown,
): value is SourceLanguageAdapter {
  return adapterShape(value) && bindings.has(value);
}

export function resolveSourceLanguageAdapter(
  value: SourceLanguageAdapter,
): SourceLanguageAdapterBindings | undefined {
  return bindings.get(value);
}

function parseConfig(
  input: unknown,
): Omit<SourceLanguageAdapterBindings, "adapter"> | undefined {
  const record = exactFrozenRecord(input, [
    "language",
    "formatterProfiles",
    "compilerAuthority",
    "compilerProfile",
    // biome-ignore lint/security/noSecrets: This is a public authority field name, not credential material.
    "symbolIndexAuthority",
  ]);
  if (record === undefined) return;
  const language = record.get("language");
  const formatterProfiles = parseFormatterProfiles(
    record.get("formatterProfiles"),
    language,
  );
  const compilerAuthority = record.get("compilerAuthority");
  const compilerProfile = parseCompilerProfile(record.get("compilerProfile"));
  // biome-ignore lint/security/noSecrets: This is a public authority field name, not credential material.
  const symbolIndexAuthority = record.get("symbolIndexAuthority");
  if (
    !isLanguage(language) ||
    formatterProfiles === undefined ||
    !isTypeScriptCompilerAuthority(compilerAuthority) ||
    compilerProfile === undefined ||
    !isSymbolIndexAuthority(symbolIndexAuthority)
  ) {
    return;
  }
  return Object.freeze({
    language,
    formatterProfiles,
    compilerAuthority,
    compilerProfile,
    symbolIndexAuthority,
  });
}

function parseFormatterProfiles(
  value: unknown,
  language: unknown,
): ReadonlyMap<string, RegisteredFormatterProfile> | undefined {
  if (
    !(Array.isArray(value) && Object.isFrozen(value)) ||
    value.length === 0 ||
    value.length > 32
  ) {
    return;
  }
  const result = new Map<string, RegisteredFormatterProfile>();
  for (const profile of value) {
    const record = exactFrozenRecord(profile, [
      "profileId",
      "language",
      "tool",
      "version",
      "configDigest",
    ]);
    const profileId = record?.get("profileId");
    if (
      record === undefined ||
      !identity(profileId) ||
      record.get("language") !== language ||
      !identity(record.get("tool")) ||
      !identity(record.get("version")) ||
      !digest(record.get("configDigest")) ||
      result.has(profileId)
    ) {
      return;
    }
    result.set(profileId, profile);
  }
  return new Map(result);
}

function parseCompilerProfile(
  value: unknown,
): TypeScriptAstLanguageAdapterConfig["compilerProfile"] | undefined {
  const record = exactFrozenRecord(value, [
    "profileId",
    "toolId",
    "toolVersion",
  ]);
  const profileId = record?.get("profileId");
  if (
    !identity(profileId) ||
    record?.get("toolId") !== "typescript" ||
    record.get("toolVersion") !== "7.0.2"
  ) {
    return;
  }
  return Object.freeze({
    profileId,
    toolId: "typescript",
    toolVersion: "7.0.2",
  });
}

function isSymbolIndexAuthority(
  value: unknown,
): value is TypeScriptAstLanguageAdapterConfig["symbolIndexAuthority"] {
  const record = exactFrozenRecord(value, ["capture"]);
  return typeof record?.get("capture") === "function";
}

function exactFrozenRecord(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    !Object.isFrozen(value)
  ) {
    return;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return;
  }
  const result = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    result.set(key, descriptor.value);
  }
  return result;
}

function adapterShape(value: unknown): value is SourceLanguageAdapter {
  const record = exactFrozenRecord(value, [
    "language",
    "parser",
    "parserVersion",
    "supportsPath",
    "supportsDeclarationKind",
    "parse",
    "catalogDeclarations",
    "digestSemantics",
    "editDeclarations",
    "formatCandidate",
    "buildSymbolIndex",
    "verifyImport",
    "validateCandidate",
  ]);
  return (
    identity(record?.get("language")) &&
    identity(record.get("parser")) &&
    identity(record.get("parserVersion")) &&
    typeof record.get("supportsPath") === "function" &&
    typeof record.get("supportsDeclarationKind") === "function" &&
    typeof record.get("parse") === "function" &&
    typeof record.get("catalogDeclarations") === "function" &&
    typeof record.get("digestSemantics") === "function" &&
    typeof record.get("editDeclarations") === "function" &&
    typeof record.get("formatCandidate") === "function" &&
    typeof record.get("buildSymbolIndex") === "function" &&
    typeof record.get("verifyImport") === "function" &&
    typeof record.get("validateCandidate") === "function"
  );
}

function isLanguage(value: unknown): value is TypeScriptAstLanguage {
  return typeof value === "string" && languages.has(value);
}

function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes("\0")
  );
}

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function rejected(): SourceLanguageAdapterCreationResult {
  return Object.freeze({
    status: "rejected",
    code: "INVALID_LANGUAGE_ADAPTER",
  });
}
