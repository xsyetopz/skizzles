// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not follow yaml's package exports; yaml is a declared runtime dependency.
// biome-ignore lint/performance/noNamespaceImport: strict validation uses the parser's document, node predicates, and visitor as one boundary.
import * as Yaml from "yaml";
import { SkillMetadataError } from "./contract.ts";

interface StrictYamlOptions {
  requireQuotedStringValues?: boolean;
}

type ProhibitedYamlConstruct = "alias" | "anchor" | "merge key" | "tag";

function parseStrictYamlObject(
  text: string,
  relativePath: string,
  options: StrictYamlOptions = {},
): Record<string, unknown> {
  const document = Yaml.parseDocument(text, {
    customTags: [],
    merge: false,
    prettyErrors: false,
    resolveKnownTags: false,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });

  let prohibitedConstruct: string | undefined;
  let hasUnquotedStringValue = false;
  Yaml.visit(document, (_key, node): symbol | undefined => {
    if (prohibitedConstruct !== undefined) {
      return Yaml.visit.BREAK;
    }
    const construct = prohibitedYamlConstruct(node);
    if (construct !== undefined) {
      prohibitedConstruct = construct;
      return Yaml.visit.BREAK;
    }
    if (
      options.requireQuotedStringValues === true &&
      _key !== "key" &&
      Yaml.isScalar(node) &&
      typeof node.value === "string" &&
      node.type !== Yaml.Scalar.QUOTE_DOUBLE &&
      node.type !== Yaml.Scalar.QUOTE_SINGLE
    ) {
      hasUnquotedStringValue = true;
    }
    return;
  });
  if (prohibitedConstruct !== undefined) {
    throw new SkillMetadataError(
      `${relativePath}: must not contain YAML aliases, anchors, tags, or merge keys (found ${prohibitedConstruct}).`,
    );
  }
  if (hasUnquotedStringValue) {
    throw new SkillMetadataError(
      `${relativePath}: string values must use single or double quotes.`,
    );
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new SkillMetadataError(`${relativePath}: contains invalid YAML.`);
  }
  if (!Yaml.isMap(document.contents)) {
    throw new SkillMetadataError(
      `${relativePath}: must contain a YAML mapping.`,
    );
  }

  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isObject(value)) {
    throw new SkillMetadataError(
      `${relativePath}: must contain a YAML mapping.`,
    );
  }
  return value;
}

function prohibitedYamlConstruct(
  node: unknown,
): ProhibitedYamlConstruct | undefined {
  if (Yaml.isAlias(node)) {
    return "alias";
  }
  if (Yaml.isNode(node) && node.anchor !== undefined) {
    return "anchor";
  }
  if (Yaml.isNode(node) && node.tag !== undefined) {
    return "tag";
  }
  if (Yaml.isPair(node) && Yaml.isScalar(node.key) && node.key.value === "<<") {
    return "merge key";
  }
  return;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { parseStrictYamlObject };
