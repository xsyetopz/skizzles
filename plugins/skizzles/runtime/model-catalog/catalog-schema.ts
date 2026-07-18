export const LUNA_MODEL = "gpt-5.6-luna";
export const REQUIRED_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", LUNA_MODEL];

export type JsonObject = Record<string, unknown>;
export type LunaOverlay = "applied" | "upstream-v2";

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

export function catalog(value: unknown): JsonObject {
  const root = object(value, "model catalog");
  if (!Array.isArray(root["models"]) || root["models"].length === 0) {
    throw new Error("model catalog must contain models");
  }
  root["models"].forEach((model, index) => {
    object(model, `model ${index}`);
  });
  return root;
}

export function assertCompleteCatalog(value: unknown): JsonObject {
  const root = catalog(value);
  const slugs = new Set(
    (root["models"] as JsonObject[]).map((model) => model["slug"]),
  );
  const missing = REQUIRED_MODELS.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `model catalog is incomplete; missing ${missing.join(", ")}`,
    );
  }
  return root;
}

export function applyLunaV2Overlay(value: unknown): {
  catalog: JsonObject;
  overlay: LunaOverlay;
} {
  const cloned = assertCompleteCatalog(structuredClone(value));
  const matches = (cloned["models"] as JsonObject[]).filter(
    (model) => model["slug"] === LUNA_MODEL,
  );
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
