import { digestText } from "../../digest.ts";
import type { SourceEvidenceAuthority } from "../../evidence/source.ts";
import {
  isSourceLanguageAdapter,
  resolveSourceLanguageAdapter,
} from "../../language/adapter.ts";
import type { SourceLanguageAdapterBindings } from "../../language/typescript-contract.ts";
import { isLiteralRegistry } from "../../policy/literal/registry.ts";
import type { EngineConfig, EngineTemplate } from "../workflow-state.ts";
import {
  boundedText,
  frozenArray,
  frozenRecord,
  identity,
  stringList,
} from "./primitives.ts";

export function parseEngineConfig(value: unknown): EngineConfig | undefined {
  const record = frozenRecord(value, [
    "sourceEvidence",
    "languageAdapters",
    "literalRegistry",
    "templates",
  ]);
  if (record === undefined) return;
  const sourceEvidence = parseSourceEvidence(record.get("sourceEvidence"));
  const languageAdapters = parseLanguageAdapters(
    record.get("languageAdapters"),
  );
  const literalRegistry = record.get("literalRegistry");
  const templates = parseTemplates(record.get("templates"));
  if (
    sourceEvidence === undefined ||
    languageAdapters === undefined ||
    !isLiteralRegistry(literalRegistry) ||
    templates === undefined
  ) {
    return;
  }
  return Object.freeze({
    sourceEvidence,
    languageAdapters,
    literalRegistry,
    templates,
  });
}

function parseSourceEvidence(
  value: unknown,
): SourceEvidenceAuthority | undefined {
  if (!isSourceEvidence(value)) return;
  return value;
}

function isSourceEvidence(value: unknown): value is SourceEvidenceAuthority {
  const record = frozenRecord(value, [
    "capture",
    "materializeTemplate",
    "recoverCapture",
    "recoverTemplate",
  ]);
  return (
    typeof record?.get("capture") === "function" &&
    typeof record.get("materializeTemplate") === "function" &&
    typeof record.get("recoverCapture") === "function" &&
    typeof record.get("recoverTemplate") === "function"
  );
}

function parseLanguageAdapters(
  value: unknown,
): ReadonlyMap<string, SourceLanguageAdapterBindings> | undefined {
  if (!frozenArray(value) || value.length === 0 || value.length > 16) return;
  const result = new Map<string, SourceLanguageAdapterBindings>();
  for (const item of value) {
    if (!isSourceLanguageAdapter(item)) return;
    const adapter = resolveSourceLanguageAdapter(item);
    if (adapter === undefined || result.has(adapter.language)) return;
    result.set(adapter.language, adapter);
  }
  return new Map(result);
}

function parseTemplates(
  value: unknown,
): ReadonlyMap<string, EngineTemplate> | undefined {
  if (!frozenArray(value) || value.length === 0 || value.length > 64) return;
  const result = new Map<string, EngineTemplate>();
  for (const item of value) {
    const record = frozenRecord(item, [
      "templateId",
      "language",
      "schemaText",
      "description",
      "bindings",
      "tool",
      "version",
    ]);
    const templateId = record?.get("templateId");
    const language = record?.get("language");
    const schemaText = record?.get("schemaText");
    const description = record?.get("description");
    const bindings = stringList(record?.get("bindings"), 64);
    const tool = record?.get("tool");
    const version = record?.get("version");
    if (
      !(
        identity(templateId) &&
        identity(language) &&
        boundedText(schemaText, 32_768) &&
        boundedText(description, 2048)
      ) ||
      bindings === undefined ||
      !identity(tool) ||
      !identity(version) ||
      result.has(templateId)
    ) {
      return;
    }
    result.set(
      templateId,
      Object.freeze({
        templateId,
        language,
        schemaText,
        schemaDigest: digestText(schemaText),
        description,
        bindings,
        tool,
        version,
      }),
    );
  }
  return result;
}
