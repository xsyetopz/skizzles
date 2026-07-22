import { digestValue } from "../../digest.ts";
import { compressContext, estimateTokens } from "./compress.ts";
import type {
  ContextBuildResult,
  ContextFragment,
  OutboundContextMiddleware,
  OutboundContextPayload,
} from "./contract.ts";
import { isContextFragment } from "./fragment.ts";
import {
  isFrozenDataObject,
  snapshotFrozenArray,
  snapshotRecord,
} from "./guard.ts";
import { prioritizeContext } from "./prioritize.ts";

interface CompressionConfig {
  readonly enabled: boolean;
  readonly targetTokenEstimate: number | null;
}

interface PayloadBinding {
  readonly inputDigest: string;
}

const maximumFragments = 256;
const maximumTokenTarget = 4_194_304;
const middlewareInstances = new WeakSet<object>();

export function createOutboundContextMiddleware(
  input: unknown = Object.freeze({}),
): OutboundContextMiddleware | undefined {
  const config = parseConfig(input);
  if (config === undefined) return;
  const payloads = new WeakMap<object, PayloadBinding>();
  let middleware: OutboundContextMiddleware;
  const build = function (
    this: unknown,
    buildInput: unknown,
  ): ContextBuildResult {
    if (this !== middleware) return rejected("INVALID_CONTEXT_INPUT");
    const fragments = parseBuildInput(buildInput);
    if (fragments === undefined) return rejected("INVALID_CONTEXT_INPUT");
    const prioritized = prioritizeContext(fragments);
    if (prioritized === undefined)
      return rejected("MISSING_PROTECTED_FRAGMENT");
    const beforeTokenEstimate = sumTokens(
      prioritized.fragments.map(({ content }) => content),
    );
    const compressed =
      config.enabled && config.targetTokenEstimate !== null
        ? compressContext(
            prioritized.fragments,
            prioritized.receipt.placements,
            config.targetTokenEstimate,
          )
        : null;
    if (compressed === undefined) {
      return rejected("TOKEN_TARGET_UNSATISFIABLE");
    }
    const sections =
      compressed === null
        ? Object.freeze(prioritized.fragments.map(({ content }) => content))
        : compressed.sections;
    const afterTokenEstimate = sumTokens(sections);
    const payloadBody = Object.freeze({
      sections,
      beforeTokenEstimate,
      afterTokenEstimate,
      prioritization: prioritized.receipt,
      compression: compressed?.receipt ?? null,
    });
    const payload: OutboundContextPayload = Object.freeze({
      ...payloadBody,
      payloadDigest: digestValue(payloadBody),
    });
    payloads.set(payload, {
      inputDigest: prioritized.receipt.inputDigest,
    });
    return Object.freeze({ status: "built", payload });
  };
  const verify = function (this: unknown, verifyInput: unknown): boolean {
    if (this !== middleware || !isFrozenDataObject(verifyInput)) return false;
    const value = snapshotRecord(verifyInput, ["fragments", "payload"]);
    const fragments = parseFragments(value?.["fragments"]);
    const payload = value?.["payload"];
    if (
      value === undefined ||
      fragments === undefined ||
      !isFrozenDataObject(payload)
    ) {
      return false;
    }
    const binding = payloads.get(payload);
    return (
      binding !== undefined &&
      binding.inputDigest === digestValue(fragments.map(({ digest }) => digest))
    );
  };
  middleware = Object.freeze({ build, verify });
  middlewareInstances.add(middleware);
  return middleware;
}

export function isOutboundContextMiddleware(
  input: unknown,
): input is OutboundContextMiddleware {
  return (
    typeof input === "object" &&
    input !== null &&
    middlewareInstances.has(input) &&
    Object.isFrozen(input)
  );
}

function parseConfig(input: unknown): CompressionConfig | undefined {
  const value = snapshotRecord(input, [], ["compression"]);
  if (value === undefined) return;
  if (!("compression" in value)) {
    return Object.freeze({ enabled: false, targetTokenEstimate: null });
  }
  const compression = snapshotRecord(
    value["compression"],
    ["enabled"],
    ["targetTokenEstimate"],
  );
  if (
    compression === undefined ||
    typeof compression["enabled"] !== "boolean"
  ) {
    return;
  }
  if (!compression["enabled"]) {
    if ("targetTokenEstimate" in compression) return;
    return Object.freeze({ enabled: false, targetTokenEstimate: null });
  }
  const target = compression["targetTokenEstimate"];
  if (
    typeof target !== "number" ||
    !Number.isSafeInteger(target) ||
    target < 1 ||
    target > maximumTokenTarget
  ) {
    return;
  }
  return Object.freeze({ enabled: true, targetTokenEstimate: target });
}

function parseBuildInput(
  input: unknown,
): readonly ContextFragment[] | undefined {
  if (!isFrozenDataObject(input)) return;
  const value = snapshotRecord(input, ["fragments"]);
  return parseFragments(value?.["fragments"]);
}

function parseFragments(
  input: unknown,
): readonly ContextFragment[] | undefined {
  const values = snapshotFrozenArray(input, maximumFragments);
  if (values === undefined) return;
  const result: ContextFragment[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (!isContextFragment(value) || ids.has(value.id)) return;
    ids.add(value.id);
    result.push(value);
  }
  return Object.freeze(result);
}

function rejected(
  code:
    | "INVALID_CONTEXT_INPUT"
    | "MISSING_PROTECTED_FRAGMENT"
    | "TOKEN_TARGET_UNSATISFIABLE",
): ContextBuildResult {
  return Object.freeze({ status: "rejected", code });
}

function sumTokens(contents: readonly string[]): number {
  let total = 0;
  for (const content of contents) total += estimateTokens(content);
  return total;
}
