import { digestTaskWorktreeValue } from "../digest.ts";
import {
  hasOnlyKeys,
  isDensePlainArray,
  isPlainDataRecord,
} from "../policy/value.ts";
import type { SandboxVerificationObjective } from "./contract.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
// biome-ignore lint/security/noSecrets: This is a public digest field name, not a credential.
const productionOverlayDigestKey = "productionOverlayDigest";

export function parseSandboxVerificationObjective(
  value: unknown,
): SandboxVerificationObjective | undefined {
  if (!(isPlainDataRecord(value) && Object.isFrozen(value))) return;
  const kind = value["kind"];
  const structuralReceiptDigest = digest(value["structuralReceiptDigest"]);
  if (structuralReceiptDigest === undefined) return;
  if (kind === "original-tests") {
    if (
      !hasExactKeys(value, [
        "baselineTestManifestDigest",
        "containerEvidenceDigest",
        "containerImageDigest",
        "kind",
        productionOverlayDigestKey,
        "structuralReceiptDigest",
      ])
    )
      return;
    const baselineTestManifestDigest = digest(
      value["baselineTestManifestDigest"],
    );
    const productionOverlayDigest = digest(value[productionOverlayDigestKey]);
    const containerImageDigest = digest(value["containerImageDigest"]);
    const containerEvidenceDigest = digest(value["containerEvidenceDigest"]);
    if (
      baselineTestManifestDigest === undefined ||
      productionOverlayDigest === undefined ||
      containerImageDigest === undefined ||
      containerEvidenceDigest === undefined
    )
      return;
    return Object.freeze({
      kind,
      structuralReceiptDigest,
      baselineTestManifestDigest,
      productionOverlayDigest,
      containerImageDigest,
      containerEvidenceDigest,
    });
  }
  if (kind === "mutation") {
    if (
      !hasExactKeys(value, [
        "inventoryDigest",
        "kind",
        "mutantIds",
        "structuralReceiptDigest",
      ])
    )
      return;
    const inventoryDigest = digest(value["inventoryDigest"]);
    const mutantIds = digestArray(value["mutantIds"], 100_000);
    if (
      inventoryDigest === undefined ||
      mutantIds === undefined ||
      mutantIds.length === 0
    )
      return;
    return Object.freeze({
      kind,
      structuralReceiptDigest,
      inventoryDigest,
      mutantIds,
    });
  }
  if (kind === "coverage")
    return parseCoverageObjective(value, structuralReceiptDigest);
  if (kind !== "property") return;
  if (
    !hasExactKeys(value, [
      "branchIds",
      "extremeVectorInventoryDigest",
      "kind",
      "nodeIds",
      "requiredCaseCount",
      "requiredExtremeVectorCount",
      "requiredExtremeVectorDigests",
      "requiredRandomFuzzCaseCount",
      "seedScheduleDigest",
      "structuralReceiptDigest",
    ])
  )
    return;
  const nodeIds = digestArray(value["nodeIds"], 100_000);
  const branchIds = digestArray(value["branchIds"], 100_000);
  if (nodeIds === undefined || nodeIds.length === 0 || branchIds === undefined)
    return;
  const seedScheduleDigest = digest(value["seedScheduleDigest"]);
  const extremeVectorInventoryDigest = digest(
    value["extremeVectorInventoryDigest"],
  );
  const requiredRandomFuzzCaseCount = positiveInteger(
    value["requiredRandomFuzzCaseCount"],
  );
  const requiredExtremeVectorCount = positiveInteger(
    value["requiredExtremeVectorCount"],
  );
  const requiredCaseCount = positiveInteger(value["requiredCaseCount"]);
  const requiredExtremeVectorDigests = digestArray(
    value["requiredExtremeVectorDigests"],
    100_000,
  );
  if (
    seedScheduleDigest === undefined ||
    extremeVectorInventoryDigest === undefined ||
    requiredRandomFuzzCaseCount === undefined ||
    requiredExtremeVectorCount === undefined ||
    requiredCaseCount === undefined ||
    requiredExtremeVectorDigests === undefined ||
    requiredExtremeVectorDigests.length === 0 ||
    requiredExtremeVectorCount !== requiredExtremeVectorDigests.length ||
    requiredCaseCount !==
      requiredRandomFuzzCaseCount + requiredExtremeVectorCount ||
    extremeVectorInventoryDigest !==
      digestTaskWorktreeValue(requiredExtremeVectorDigests)
  )
    return;
  return Object.freeze({
    kind,
    structuralReceiptDigest,
    seedScheduleDigest,
    requiredRandomFuzzCaseCount,
    requiredExtremeVectorCount,
    requiredCaseCount,
    requiredExtremeVectorDigests,
    extremeVectorInventoryDigest,
    nodeIds,
    branchIds,
  });
}

function parseCoverageObjective(
  value: Record<string, unknown>,
  structuralReceiptDigest: `sha256:${string}`,
): Extract<SandboxVerificationObjective, { kind: "coverage" }> | undefined {
  if (
    !hasExactKeys(value, [
      "kind",
      "modifiedNodes",
      "structuralReceiptDigest",
      "thresholds",
    ])
  )
    return;
  const modifiedNodes = parseCoverageNodes(value["modifiedNodes"]);
  const thresholds = parseCoverageThresholds(value["thresholds"]);
  if (modifiedNodes === undefined || thresholds === undefined) return;
  return Object.freeze({
    kind: "coverage",
    structuralReceiptDigest,
    modifiedNodes,
    thresholds,
  });
}

function parseCoverageNodes(
  value: unknown,
):
  | Extract<SandboxVerificationObjective, { kind: "coverage" }>["modifiedNodes"]
  | undefined {
  if (
    !isDensePlainArray(value) ||
    !Object.isFrozen(value) ||
    value.length === 0 ||
    value.length > 100_000
  )
    return;
  const nodes: Extract<
    SandboxVerificationObjective,
    { kind: "coverage" }
  >["modifiedNodes"][number][] = [];
  const nodeIds = new Set<string>();
  const lineIds = new Set<string>();
  const branchIds = new Set<string>();
  for (const raw of value) {
    if (
      !isPlainDataRecord(raw) ||
      !Object.isFrozen(raw) ||
      !hasExactKeys(raw, ["branchIds", "lineIds", "nodeId"])
    )
      return;
    const nodeId = digest(raw["nodeId"]);
    const nodeLineIds = digestArray(raw["lineIds"], 100_000);
    const nodeBranchIds = digestArray(raw["branchIds"], 100_000);
    if (
      nodeId === undefined ||
      nodeIds.has(nodeId) ||
      nodeLineIds === undefined ||
      nodeLineIds.length === 0 ||
      nodeBranchIds === undefined ||
      nodeLineIds.some((lineId) => lineIds.has(lineId)) ||
      nodeBranchIds.some((branchId) => branchIds.has(branchId))
    )
      return;
    nodeIds.add(nodeId);
    for (const lineId of nodeLineIds) lineIds.add(lineId);
    for (const branchId of nodeBranchIds) branchIds.add(branchId);
    nodes.push(
      Object.freeze({
        nodeId,
        lineIds: nodeLineIds,
        branchIds: nodeBranchIds,
      }),
    );
  }
  return Object.freeze(nodes);
}

function parseCoverageThresholds(
  value: unknown,
):
  | Extract<SandboxVerificationObjective, { kind: "coverage" }>["thresholds"]
  | undefined {
  if (
    !isPlainDataRecord(value) ||
    !Object.isFrozen(value) ||
    !hasExactKeys(value, [
      "minimumBranchHits",
      "minimumLineHits",
      "minimumNodeHits",
    ])
  )
    return;
  const minimumNodeHits = positiveInteger(value["minimumNodeHits"]);
  const minimumLineHits = positiveInteger(value["minimumLineHits"]);
  const minimumBranchHits = positiveInteger(value["minimumBranchHits"]);
  if (
    minimumNodeHits === undefined ||
    minimumLineHits === undefined ||
    minimumBranchHits === undefined
  )
    return;
  return Object.freeze({
    minimumNodeHits,
    minimumLineHits,
    minimumBranchHits,
  });
}

export function sandboxVerificationObjectiveDigest(
  objective: SandboxVerificationObjective,
): `sha256:${string}` {
  return digestTaskWorktreeValue(objective);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length && hasOnlyKeys(value, keys)
  );
}

function digest(value: unknown): `sha256:${string}` | undefined {
  return typeof value === "string" && digestPattern.test(value)
    ? (value as `sha256:${string}`)
    : undefined;
}

function digestArray(
  value: unknown,
  maximum: number,
): readonly `sha256:${string}`[] | undefined {
  if (
    !(isDensePlainArray(value) && Object.isFrozen(value)) ||
    value.length > maximum
  )
    return;
  const results: `sha256:${string}`[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const parsed = digest(raw);
    if (parsed === undefined || seen.has(parsed)) return;
    seen.add(parsed);
    results.push(parsed);
  }
  return Object.freeze(results);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 100_000_000
    ? value
    : undefined;
}
