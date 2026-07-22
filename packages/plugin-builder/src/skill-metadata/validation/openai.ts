import {
  BRAND_COLOR_LENGTH,
  BRAND_COLOR_PATTERN,
  DEFAULT_PROMPT_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  ICON_PATH_MAX_LENGTH,
  SHORT_DESCRIPTION_MAX_LENGTH,
  SHORT_DESCRIPTION_MIN_LENGTH,
  type SkillAssetBinding,
  SkillMetadataError,
  type SkillMetadataFile,
  TOOL_IDENTIFIER_MAX_LENGTH,
  TOOL_IDENTIFIER_PATTERN,
  TOOL_TEXT_MAX_LENGTH,
  TRANSPORT_MAX_LENGTH,
  URL_MAX_LENGTH,
} from "../contract.ts";
import { validateContainedAsset } from "../filesystem/asset.ts";
import {
  APPROVED_BARE_MCP_IDENTITIES,
  APPROVED_CLI_IDENTITIES,
  APPROVED_LOCAL_MCP_COMMANDS,
  SKILL_METADATA_CONTRACT_VERSION,
} from "../official/v1/contract.ts";
import { isApprovedMcpEndpoint } from "../official/v1/mcp-endpoint.ts";
import {
  assertExactKeys,
  boundedString,
  decodeMetadataText,
  objectValue,
} from "../parsing/text.ts";
import { parseStrictYamlObject } from "../parsing/yaml.ts";

const OPENAI_KEYS = ["dependencies", "interface", "policy"] as const;
const INTERFACE_KEYS = [
  "brand_color",
  "default_prompt",
  "display_name",
  "icon_large",
  "icon_small",
  "short_description",
] as const;
const POLICY_KEYS = ["allow_implicit_invocation", "products"] as const;
const DEPENDENCIES_KEYS = ["tools"] as const;
const TOOL_KEYS = [
  "command",
  "description",
  "transport",
  "type",
  "url",
  "value",
] as const;
const SKILL_NAME_CONTINUATION = /[A-Za-z0-9_:-]/u;
const PRODUCTS = new Set([
  "atlas",
  "ATLAS",
  "chatgpt",
  "CHATGPT",
  "codex",
  "CODEX",
]);
const APPROVED_LOCAL_COMMAND_BY_VALUE = new Map<string, string>(
  APPROVED_LOCAL_MCP_COMMANDS.map(({ command, value }) => [value, command]),
);
const APPROVED_BARE_MCP_IDENTITY_SET = new Set(APPROVED_BARE_MCP_IDENTITIES);
const APPROVED_CLI_IDENTITY_SET = new Set(APPROVED_CLI_IDENTITIES);

async function validateOpenAiMetadata(
  root: string,
  directoryName: string,
  file: SkillMetadataFile,
): Promise<readonly SkillAssetBinding[]> {
  const value = parseStrictYamlObject(
    decodeMetadataText(file),
    file.relativePath,
    { requireQuotedStringValues: true },
  );
  assertExactKeys(value, OPENAI_KEYS, file.relativePath, "metadata", true);
  let assets: readonly SkillAssetBinding[] = [];
  if ("interface" in value) {
    assets = await validateInterface(
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
  return assets;
}

async function validateInterface(
  root: string,
  directoryName: string,
  value: Record<string, unknown>,
  path: string,
): Promise<readonly SkillAssetBinding[]> {
  assertExactKeys(value, INTERFACE_KEYS, path, "interface", true);
  if ("display_name" in value) {
    boundedString(
      value["display_name"],
      path,
      "display_name",
      DISPLAY_NAME_MAX_LENGTH,
    );
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
  const assets = new Map<string, SkillAssetBinding>();
  for (const key of ["icon_small", "icon_large"] as const) {
    if (key in value) {
      const iconPath = boundedString(
        value[key],
        path,
        key,
        ICON_PATH_MAX_LENGTH,
      );

      const asset = await validateContainedAsset(
        root,
        directoryName,
        iconPath,
        path,
        key,
      );
      assets.set(asset.relativePath, asset);
    }
  }
  return [...assets.values()];
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
  if ("products" in value) {
    if (!Array.isArray(value["products"])) {
      throw new SkillMetadataError(
        `${path}: policy.products must be an array.`,
      );
    }
    const products = new Set<string>();
    for (const product of value["products"]) {
      if (typeof product !== "string" || !PRODUCTS.has(product)) {
        throw new SkillMetadataError(
          `${path}: policy.products contains an unsupported product.`,
        );
      }
      const normalized = product.toLowerCase();
      if (products.has(normalized)) {
        throw new SkillMetadataError(
          `${path}: policy.products contains a duplicate product.`,
        );
      }
      products.add(normalized);
    }
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
  if (type !== "mcp" && type !== "cli") {
    throw new SkillMetadataError(
      `${path}: dependency type must be mcp or cli.`,
    );
  }
  if (!TOOL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new SkillMetadataError(`${path}: ${itemPath}.value is invalid.`);
  }
  if (identities.has(identifier)) {
    throw new SkillMetadataError(`${path}: duplicate dependency identity.`);
  }
  identities.add(identifier);
  validateToolDescription(tool, itemPath, path);
  if (type === "cli") {
    if ("transport" in tool || "command" in tool || "url" in tool) {
      throw new SkillMetadataError(
        `${path}: ${itemPath} CLI dependency contains MCP-only fields.`,
      );
    }
    if (!APPROVED_CLI_IDENTITY_SET.has(identifier)) {
      throw new SkillMetadataError(
        `${path}: ${itemPath} must match an approved CLI identity.`,
      );
    }
    return;
  }
  validateMcpEndpoint(tool, itemPath, path, identifier);
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

function validateMcpEndpoint(
  tool: Record<string, unknown>,
  itemPath: string,
  path: string,
  identifier: string,
): void {
  const hasTransport = "transport" in tool;
  const hasUrl = "url" in tool;
  const hasCommand = "command" in tool;
  if (hasCommand) {
    const transport = hasTransport
      ? boundedString(
          tool["transport"],
          path,
          `${itemPath}.transport`,
          TRANSPORT_MAX_LENGTH,
        )
      : undefined;
    if (hasUrl || (transport !== undefined && transport !== "stdio")) {
      throw new SkillMetadataError(
        `${path}: ${itemPath} command must use the stdio MCP form.`,
      );
    }
    const command = boundedString(
      tool["command"],
      path,
      `${itemPath}.command`,
      TOOL_TEXT_MAX_LENGTH,
    );
    if (APPROVED_LOCAL_COMMAND_BY_VALUE.get(identifier) !== command) {
      throw new SkillMetadataError(
        `${path}: ${itemPath} must match an approved local MCP command.`,
      );
    }
    return;
  }
  if (hasTransport !== hasUrl) {
    throw new SkillMetadataError(
      `${path}: ${itemPath}.transport and url must be declared together.`,
    );
  }
  if (!(hasTransport && hasUrl)) {
    if (!APPROVED_BARE_MCP_IDENTITY_SET.has(identifier)) {
      throw new SkillMetadataError(
        `${path}: ${itemPath} must match an approved bare MCP identity.`,
      );
    }
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
