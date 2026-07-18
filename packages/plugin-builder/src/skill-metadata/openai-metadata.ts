import { isIP } from "node:net";
import { validateContainedAsset } from "./asset-boundary.ts";
import {
  BRAND_COLOR_LENGTH,
  BRAND_COLOR_PATTERN,
  DEFAULT_PROMPT_MAX_LENGTH,
  ICON_PATH_MAX_LENGTH,
  INTERFACE_TEXT_MAX_LENGTH,
  SkillMetadataError,
  type SkillMetadataFile,
  TOOL_IDENTIFIER_MAX_LENGTH,
  TOOL_IDENTIFIER_PATTERN,
  TOOL_TEXT_MAX_LENGTH,
  TRANSPORT_MAX_LENGTH,
  URL_MAX_LENGTH,
} from "./contract.ts";
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

async function validateOpenAiMetadata(
  root: string,
  directoryName: string,
  file: SkillMetadataFile,
): Promise<void> {
  const value = parseStrictYamlObject(
    decodeMetadataText(file),
    file.relativePath,
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
  if ("default_prompt" in value) {
    boundedString(
      value["default_prompt"],
      path,
      "default_prompt",
      DEFAULT_PROMPT_MAX_LENGTH,
    );
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
  validateToolEndpoint(tool, itemPath, path);
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
  if (!isSafeHttpsUrl(url)) {
    throw new SkillMetadataError(
      `${path}: ${itemPath}.url must be a safe HTTPS URL.`,
    );
  }
}

function isSafeHttpsUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hostname !== "" &&
    parsed.hash === "" &&
    !isLocalNetworkHost(parsed.hostname)
  );
}

function isLocalNetworkHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    !normalized.includes(".") ||
    isIP(normalized) !== 0 ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (!isIpv4(octets)) {
    return false;
  }
  const first = octets[0];
  const second = octets[1];
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

function isIpv4(octets: number[]): octets is [number, number, number, number] {
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    )
  );
}

export { validateOpenAiMetadata };
