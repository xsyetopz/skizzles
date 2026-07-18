import { validateContainedAsset } from "./asset-boundary.ts";
import {
  BRAND_COLOR_LENGTH,
  BRAND_COLOR_PATTERN,
  DEFAULT_PROMPT_MAX_LENGTH,
  ICON_PATH_MAX_LENGTH,
  INTERFACE_TEXT_MAX_LENGTH,
  SHORT_DESCRIPTION_MAX_LENGTH,
  SHORT_DESCRIPTION_MIN_LENGTH,
  SkillMetadataError,
  type SkillMetadataFile,
  TOOL_IDENTIFIER_MAX_LENGTH,
  TOOL_IDENTIFIER_PATTERN,
  TOOL_TEXT_MAX_LENGTH,
  TRANSPORT_MAX_LENGTH,
  URL_MAX_LENGTH,
} from "./contract.ts";
import { isApprovedMcpEndpoint } from "./mcp-endpoint-v1.ts";
import { SKILL_METADATA_CONTRACT_VERSION } from "./official-contract-v1.ts";
import {
  assertExactKeys,
  boundedString,
  decodeMetadataText,
  objectValue,
} from "./text-contract.ts";
import { parseStrictYamlObject } from "./yaml-contract.ts";

const OPENAI_KEYS = ["dependencies", "interface", "policy"] as const;
const INTERFACE_KEYS = [
  "brand_color",
  "default_prompt",
  "display_name",
  "icon_large",
  "icon_small",
  "short_description",
] as const;
const POLICY_KEYS = ["allow_implicit_invocation"] as const;
const DEPENDENCIES_KEYS = ["tools"] as const;
const TOOL_KEYS = ["description", "transport", "type", "url", "value"] as const;
const SKILL_NAME_CONTINUATION = /[a-z0-9-]/u;

async function validateOpenAiMetadata(
  root: string,
  directoryName: string,
  file: SkillMetadataFile,
): Promise<void> {
  const value = parseStrictYamlObject(
    decodeMetadataText(file),
    file.relativePath,
    { requireQuotedStringValues: true },
  );
  assertExactKeys(value, OPENAI_KEYS, file.relativePath, "metadata", true);
  if ("interface" in value) {
    await validateInterface(
      root,
      directoryName,
      objectValue(value["interface"], file.relativePath, "interface"),
      file.relativePath,
    );
  }
  if ("policy" in value) {
    validatePolicy(
      objectValue(value["policy"], file.relativePath, "policy"),
      file.relativePath,
    );
  }
  if ("dependencies" in value) {
    validateDependencies(value["dependencies"], file.relativePath);
  }
}

async function validateInterface(
  root: string,
  directoryName: string,
  value: Record<string, unknown>,
  path: string,
): Promise<void> {
  assertExactKeys(value, INTERFACE_KEYS, path, "interface", true);
  for (const key of ["display_name", "short_description"] as const) {
    if (key in value) {
      boundedString(value[key], path, key, INTERFACE_TEXT_MAX_LENGTH);
    }
  }
  if ("short_description" in value) {
    const shortDescription = boundedString(
      value["short_description"],
      path,
      "short_description",
      SHORT_DESCRIPTION_MAX_LENGTH,
    );
    if ([...shortDescription].length < SHORT_DESCRIPTION_MIN_LENGTH) {
      throw new SkillMetadataError(
        `${path}: short_description must contain 25 to 64 characters.`,
      );
    }
  }
  if ("default_prompt" in value) {
    const defaultPrompt = boundedString(
      value["default_prompt"],
      path,
      "default_prompt",
      DEFAULT_PROMPT_MAX_LENGTH,
    );
    if (!mentionsSkillInvocation(defaultPrompt, directoryName)) {
      throw new SkillMetadataError(
        `${path}: default_prompt must explicitly mention $${directoryName}.`,
      );
    }
  }
  if ("brand_color" in value) {
    const color = boundedString(
      value["brand_color"],
      path,
      "brand_color",
      BRAND_COLOR_LENGTH,
    );
    if (!BRAND_COLOR_PATTERN.test(color)) {
      throw new SkillMetadataError(
        `${path}: brand_color must use canonical #RRGGBB.`,
      );
    }
  }
  for (const key of ["icon_small", "icon_large"] as const) {
    if (key in value) {
      const iconPath = boundedString(
        value[key],
        path,
        key,
        ICON_PATH_MAX_LENGTH,
      );
      // biome-ignore lint/performance/noAwaitInLoops: documented icon fields retain deterministic field-order diagnostics.
      await validateContainedAsset(root, directoryName, iconPath, path, key);
    }
  }
}

function mentionsSkillInvocation(prompt: string, skillName: string): boolean {
  const token = `$${skillName}`;
  let offset = prompt.indexOf(token);
  while (offset >= 0) {
    const nextCharacter = prompt[offset + token.length];
    if (
      nextCharacter === undefined ||
      !SKILL_NAME_CONTINUATION.test(nextCharacter)
    ) {
      return true;
    }
    offset = prompt.indexOf(token, offset + token.length);
  }
  return false;
}

function validatePolicy(value: Record<string, unknown>, path: string): void {
  assertExactKeys(value, POLICY_KEYS, path, "policy", true);
  if (
    "allow_implicit_invocation" in value &&
    typeof value["allow_implicit_invocation"] !== "boolean"
  ) {
    throw new SkillMetadataError(
      `${path}: allow_implicit_invocation must be a boolean.`,
    );
  }
}

function validateDependencies(value: unknown, path: string): void {
  const dependencies = objectValue(value, path, "dependencies");
  assertExactKeys(dependencies, DEPENDENCIES_KEYS, path, "dependencies", true);
  if (!Array.isArray(dependencies["tools"])) {
    throw new SkillMetadataError(
      `${path}: dependencies.tools must be an array.`,
    );
  }
  const identities = new Set<string>();
  for (const [index, item] of dependencies["tools"].entries()) {
    validateToolDependency(item, index, identities, path);
  }
}

function validateToolDependency(
  value: unknown,
  index: number,
  identities: Set<string>,
  path: string,
): void {
  const itemPath = `dependencies.tools[${index}]`;
  const tool = objectValue(value, path, itemPath);
  assertExactKeys(tool, TOOL_KEYS, path, itemPath, true);
  const type = boundedString(
    tool["type"],
    path,
    `${itemPath}.type`,
    TRANSPORT_MAX_LENGTH,
  );
  const identifier = boundedString(
    tool["value"],
    path,
    `${itemPath}.value`,
    TOOL_IDENTIFIER_MAX_LENGTH,
  );
  if (type !== "mcp") {
    throw new SkillMetadataError(`${path}: dependency type must be mcp.`);
  }
  if (!TOOL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new SkillMetadataError(`${path}: ${itemPath}.value is invalid.`);
  }
  if (identities.has(identifier)) {
    throw new SkillMetadataError(`${path}: duplicate MCP dependency value.`);
  }
  identities.add(identifier);
  validateToolDescription(tool, itemPath, path);
  validateToolEndpoint(tool, itemPath, path, identifier);
}

function validateToolDescription(
  tool: Record<string, unknown>,
  itemPath: string,
  path: string,
): void {
  if ("description" in tool) {
    boundedString(
      tool["description"],
      path,
      `${itemPath}.description`,
      TOOL_TEXT_MAX_LENGTH,
    );
  }
}

function validateToolEndpoint(
  tool: Record<string, unknown>,
  itemPath: string,
  path: string,
  identifier: string,
): void {
  const hasTransport = "transport" in tool;
  const hasUrl = "url" in tool;
  if (hasTransport !== hasUrl) {
    throw new SkillMetadataError(
      `${path}: ${itemPath}.transport and url must be declared together.`,
    );
  }
  if (!(hasTransport && hasUrl)) {
    return;
  }
  const transport = boundedString(
    tool["transport"],
    path,
    `${itemPath}.transport`,
    TRANSPORT_MAX_LENGTH,
  );
  if (transport !== "streamable_http") {
    throw new SkillMetadataError(
      `${path}: ${itemPath}.transport must be streamable_http.`,
    );
  }
  const url = boundedString(
    tool["url"],
    path,
    `${itemPath}.url`,
    URL_MAX_LENGTH,
  );
  if (!isApprovedMcpEndpoint(identifier, url)) {
    throw new SkillMetadataError(
      `${path}: ${itemPath} must match approved MCP endpoint contract ${SKILL_METADATA_CONTRACT_VERSION}.`,
    );
  }
}

export { validateOpenAiMetadata };
