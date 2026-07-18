// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not follow yaml's package exports; yaml is a declared runtime dependency.
// biome-ignore lint/performance/noNamespaceImport: strict validation uses the parser's document, node predicates, and visitor as one boundary.
import * as Yaml from "yaml";
import { SkillMetadataError } from "./contract.ts";

function parseStrictYamlObject(
  text: string,
  relativePath: string,
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
  Yaml.visit(document, (_key, node): symbol | undefined => {
    if (prohibitedConstruct !== undefined) {
      return Yaml.visit.BREAK;
    }
    if (Yaml.isAlias(node)) {
      prohibitedConstruct = "alias";
      return Yaml.visit.BREAK;
    }
    if (Yaml.isNode(node) && node.anchor !== undefined) {
      prohibitedConstruct = "anchor";
      return Yaml.visit.BREAK;
    }
    if (Yaml.isNode(node) && node.tag !== undefined) {
      prohibitedConstruct = "tag";
      return Yaml.visit.BREAK;
    }
    if (
      Yaml.isPair(node) &&
      Yaml.isScalar(node.key) &&
      node.key.value === "<<"
    ) {
      prohibitedConstruct = "merge key";
      return Yaml.visit.BREAK;
    }
    return undefined;
  });
  if (prohibitedConstruct !== undefined) {
    throw new SkillMetadataError(
      `${relativePath}: must not contain YAML aliases, anchors, tags, or merge keys (found ${prohibitedConstruct}).`,
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { parseStrictYamlObject };
