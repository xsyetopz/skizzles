export const LUNA_MODEL = "gpt-5.6-luna";
export const REQUIRED_MODELS: readonly string[] = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  LUNA_MODEL,
];

export type JsonObject = Record<string, unknown>;
export interface ModelCatalog extends JsonObject {
  models: JsonObject[];
}
export interface CatalogCache extends JsonObject {
  client_version: string;
  fetched_at: string;
  models: JsonObject[];
}
export type LunaOverlay = "applied" | "upstream-v2";

function object(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function parseJson(contents: string): unknown {
  const value: unknown = JSON.parse(contents);
  return value;
}

export function parseCatalogCache(value: unknown): CatalogCache {
  if (!isJsonObject(value)) {
    throw new Error("model catalog cache is invalid");
  }
  try {
    const clientVersion = value["client_version"];
    const fetchedAt = value["fetched_at"];
    const modelsValue = value["models"];
    if (
      typeof clientVersion !== "string" ||
      typeof fetchedAt !== "string" ||
      !Array.isArray(modelsValue) ||
      !modelsValue.every(isJsonObject)
    ) {
      throw new Error("model catalog cache is invalid");
    }
    return {
      ...value,
      client_version: clientVersion,
      fetched_at: fetchedAt,
      models: modelsValue,
    };
  } catch {
    throw new Error("model catalog cache is invalid");
  }
}

export function catalog(value: unknown): ModelCatalog {
  const root = object(value, "model catalog");
  const modelsValue = root["models"];
  if (!Array.isArray(modelsValue) || modelsValue.length === 0) {
    throw new Error("model catalog must contain models");
  }
  const models = modelsValue.map((model, index) =>
    object(model, `model ${index}`),
  );
  return { ...root, models };
}

export function assertCompleteCatalog(value: unknown): ModelCatalog {
  const root = catalog(value);
  const slugs = new Set(root.models.map((model) => model["slug"]));
  const missing = REQUIRED_MODELS.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `model catalog is incomplete; missing ${missing.join(", ")}`,
    );
  }
  return root;
}

export function applyLunaV2Overlay(value: unknown): {
  catalog: ModelCatalog;
  overlay: LunaOverlay;
} {
  const cloned = assertCompleteCatalog(structuredClone(value));
  const matches = cloned.models.filter((model) => model["slug"] === LUNA_MODEL);
  const luna = matches[0];
  if (matches.length !== 1 || luna === undefined) {
    throw new Error(
      `expected exactly one ${LUNA_MODEL} model, found ${matches.length}`,
    );
  }
  if (luna["multi_agent_version"] === "v2") {
    return { catalog: cloned, overlay: "upstream-v2" };
  }
  if (luna["multi_agent_version"] !== "v1") {
    throw new Error(`${LUNA_MODEL} has unexpected multi_agent_version`);
  }
  luna["multi_agent_version"] = "v2";
  return { catalog: cloned, overlay: "applied" };
}
