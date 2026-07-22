import type {
  BatchRequest,
  BatchTarget,
  EngineOperation,
  EngineSelector,
} from "../workflow-state.ts";
import { parseDescribeRequest } from "./describe.ts";
import {
  boundedText,
  exactKeys,
  frozenArray,
  frozenRecord,
  identity,
  isDigest,
  objectValue,
  snapshotRecord,
  sourcePath,
  stringList,
} from "./primitives.ts";

export function parseBatchRequest(value: unknown): BatchRequest | undefined {
  const record = frozenRecord(value, [
    "requestDigest",
    "repository",
    "language",
    "objective",
    "targets",
    "formatterId",
    "faultCases",
    "context",
    "contextDigest",
  ]);
  if (record === undefined) return;
  const described = parseDescribeRequest(
    Object.freeze({
      requestDigest: record.get("requestDigest"),
      repository: record.get("repository"),
      language: record.get("language"),
      objective: record.get("objective"),
      targets: targetPathsOf(record.get("targets")),
      formatterId: record.get("formatterId"),
    }),
  );
  if (described === undefined) return;
  const targets = parseBatchTargets(record.get("targets"));
  const faultCases = parseFaultCases(record.get("faultCases"));
  const context = objectValue(record.get("context"));
  const contextDigest = record.get("contextDigest");
  if (
    targets === undefined ||
    !validEpochPlan(targets) ||
    faultCases === undefined ||
    context === undefined ||
    !isDigest(contextDigest)
  ) {
    return;
  }
  return Object.freeze({
    ...described,
    targets,
    faultCases,
    context,
    contextDigest,
  });
}

function targetPathsOf(value: unknown): readonly Readonly<{ path: unknown }>[] {
  if (!frozenArray(value)) return Object.freeze([]);
  const result: Readonly<{ path: unknown }>[] = [];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const item = descriptors[String(index)];
    if (item === undefined || !("value" in item)) return Object.freeze([]);
    const record = snapshotRecord(item.value);
    result.push(Object.freeze({ path: record?.get("path") }));
  }
  return Object.freeze(result);
}

function parseBatchTargets(value: unknown): readonly BatchTarget[] | undefined {
  if (!frozenArray(value) || value.length === 0 || value.length > 256) return;
  const result: BatchTarget[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = frozenRecord(item, ["path", "operations"]);
    const path = record?.get("path");
    const operations = parseOperations(record?.get("operations"));
    if (!sourcePath(path) || operations === undefined || seen.has(path)) return;
    seen.add(path);
    result.push(Object.freeze({ path, operations }));
  }
  return Object.freeze(
    result.sort((left, right) => left.path.localeCompare(right.path)),
  );
}

function parseOperations(
  value: unknown,
): readonly EngineOperation[] | undefined {
  if (!frozenArray(value) || value.length === 0 || value.length > 256) return;
  const result: EngineOperation[] = [];
  for (const item of value) {
    const record = snapshotRecord(item);
    const kind = record?.get("kind");
    const epoch = record?.get("epoch");
    if (!positiveEpoch(epoch)) return;
    if (kind === "delete" && exactKeys(record, ["epoch", "kind", "selector"])) {
      const selector = parseSelector(record.get("selector"));
      if (selector === undefined) return;
      result.push(Object.freeze({ epoch, kind, selector }));
    } else if (
      kind === "replace" &&
      exactKeys(record, [
        "epoch",
        "kind",
        "selector",
        "templateId",
        "nodeSource",
      ])
    ) {
      const selector = parseSelector(record.get("selector"));
      const templateId = record.get("templateId");
      const nodeSource = record.get("nodeSource");
      if (
        selector === undefined ||
        !identity(templateId) ||
        !boundedText(nodeSource, 262_144)
      )
        return;
      result.push(
        Object.freeze({ epoch, kind, selector, templateId, nodeSource }),
      );
    } else if (
      kind === "insert" &&
      exactKeys(record, [
        "epoch",
        "kind",
        "anchor",
        "position",
        "templateId",
        "nodeSource",
      ])
    ) {
      const anchor = parseSelector(record.get("anchor"));
      const position = record.get("position");
      const templateId = record.get("templateId");
      const nodeSource = record.get("nodeSource");
      if (
        anchor === undefined ||
        (position !== "before" && position !== "after") ||
        !identity(templateId) ||
        !boundedText(nodeSource, 262_144)
      )
        return;
      result.push(
        Object.freeze({
          epoch,
          kind,
          anchor,
          position,
          templateId,
          nodeSource,
        }),
      );
    } else return;
  }
  return Object.freeze(result);
}

function validEpochPlan(targets: readonly BatchTarget[]): boolean {
  const epochs = new Set<number>();
  for (const target of targets) {
    let predecessor = 0;
    const seenNodes = new Set<string>();
    for (const operation of target.operations) {
      if (operation.epoch < predecessor) return false;
      predecessor = operation.epoch;
      epochs.add(operation.epoch);
      const selector =
        operation.kind === "insert" ? operation.anchor : operation.selector;
      const nodeKey = `${selector.declarationKind}\0${selector.name}`;
      if (seenNodes.has(nodeKey)) return false;
      seenNodes.add(nodeKey);
    }
  }
  const sorted = [...epochs].sort((left, right) => left - right);
  return (
    sorted.length > 0 && sorted.every((epoch, index) => epoch === index + 1)
  );
}

function positiveEpoch(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    typeof value === "number" &&
    value > 0 &&
    value <= 256
  );
}

function parseSelector(value: unknown): EngineSelector | undefined {
  const record = frozenRecord(value, [
    "declarationKind",
    "name",
    "expectedNodeDigest",
  ]);
  const declarationKind = record?.get("declarationKind");
  const name = record?.get("name");
  const expectedNodeDigest = record?.get("expectedNodeDigest");
  if (
    !(
      identity(declarationKind) &&
      identity(name) &&
      isDigest(expectedNodeDigest)
    )
  )
    return;
  return Object.freeze({ declarationKind, name, expectedNodeDigest });
}

function parseFaultCases(
  value: unknown,
): BatchRequest["faultCases"] | undefined {
  const record = frozenRecord(value, ["declarations", "negativeTests"]);
  const declarations = parseFaultDeclarations(record?.get("declarations"));
  const negativeTests = parseNegativeTests(record?.get("negativeTests"));
  if (declarations === undefined || negativeTests === undefined) return;
  return Object.freeze({ declarations, negativeTests });
}

function parseFaultDeclarations(
  value: unknown,
): BatchRequest["faultCases"]["declarations"] | undefined {
  if (!frozenArray(value) || value.length > 256) return;
  const result: {
    readonly productionPath: string;
    readonly failureCodes: readonly string[];
  }[] = [];
  for (const item of value) {
    const record = frozenRecord(item, ["productionPath", "failureCodes"]);
    const productionPath = record?.get("productionPath");
    const failureCodes = stringList(record?.get("failureCodes"), 64);
    if (!sourcePath(productionPath) || failureCodes === undefined) return;
    result.push(Object.freeze({ productionPath, failureCodes }));
  }
  return Object.freeze(result);
}

function parseNegativeTests(
  value: unknown,
): BatchRequest["faultCases"]["negativeTests"] | undefined {
  if (!frozenArray(value) || value.length > 256) return;
  const result: {
    readonly productionPath: string;
    readonly testPath: string;
  }[] = [];
  for (const item of value) {
    const record = frozenRecord(item, ["productionPath", "testPath"]);
    const productionPath = record?.get("productionPath");
    const testPath = record?.get("testPath");
    if (!(sourcePath(productionPath) && sourcePath(testPath))) return;
    result.push(Object.freeze({ productionPath, testPath }));
  }
  return Object.freeze(result);
}
