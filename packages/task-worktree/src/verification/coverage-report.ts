import { isPlainDataRecord } from "../policy/value.ts";
import type { SandboxVerificationObjective } from "../sandbox/contract.ts";
import type { TaskWorktreeVerificationReport } from "./contract.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export function parseCoverageArtifactReport(
  value: Record<string, unknown>,
  outcome: "failed" | "passed",
  objective: Extract<SandboxVerificationObjective, { kind: "coverage" }>,
): Extract<TaskWorktreeVerificationReport, { kind: "coverage" }> | undefined {
  if (!hasExactKeys(value, ["kind", "nodes", "outcome"])) return;
  const nodes = coverageNodes(value["nodes"], objective.modifiedNodes);
  return nodes === undefined || nodes.length === 0
    ? undefined
    : Object.freeze({ kind: "coverage", outcome, nodes });
}

function coverageNodes(
  value: unknown,
  expectedNodes: Extract<
    SandboxVerificationObjective,
    { kind: "coverage" }
  >["modifiedNodes"],
):
  | Extract<TaskWorktreeVerificationReport, { kind: "coverage" }>["nodes"]
  | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== expectedNodes.length ||
    value.length > 100_000
  )
    return;
  const expected = new Map(expectedNodes.map((node) => [node.nodeId, node]));
  const results: Extract<
    TaskWorktreeVerificationReport,
    { kind: "coverage" }
  >["nodes"][number][] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (
      !isPlainDataRecord(raw) ||
      !hasExactKeys(raw, ["branches", "hits", "lines", "nodeId"])
    )
      return;
    const nodeId = digest(raw["nodeId"]);
    const hits = count(raw["hits"]);
    const expectedNode =
      nodeId === undefined ? undefined : expected.get(nodeId);
    const lines = coverageLines(raw["lines"], expectedNode?.lineIds);
    const branches = coverageBranches(raw["branches"], expectedNode?.branchIds);
    if (
      nodeId === undefined ||
      seen.has(nodeId) ||
      expectedNode === undefined ||
      hits === undefined ||
      lines === undefined ||
      branches === undefined
    )
      return;
    seen.add(nodeId);
    results.push(Object.freeze({ nodeId, hits, lines, branches }));
  }
  return Object.freeze(results);
}

function coverageLines(
  value: unknown,
  expected: readonly `sha256:${string}`[] | undefined,
):
  | readonly Readonly<{ lineId: `sha256:${string}`; hits: number }>[]
  | undefined {
  if (
    !Array.isArray(value) ||
    expected === undefined ||
    value.length !== expected.length
  )
    return;
  const expectedIds = new Set(expected);
  const results: Readonly<{
    lineId: `sha256:${string}`;
    hits: number;
  }>[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isPlainDataRecord(raw) || !hasExactKeys(raw, ["hits", "lineId"]))
      return;
    const lineId = digest(raw["lineId"]);
    const hits = count(raw["hits"]);
    if (
      lineId === undefined ||
      !expectedIds.has(lineId) ||
      seen.has(lineId) ||
      hits === undefined
    )
      return;
    seen.add(lineId);
    results.push(Object.freeze({ lineId, hits }));
  }
  return Object.freeze(results);
}

function coverageBranches(
  value: unknown,
  expected: readonly `sha256:${string}`[] | undefined,
):
  | readonly Readonly<{ branchId: `sha256:${string}`; hits: number }>[]
  | undefined {
  if (
    !Array.isArray(value) ||
    expected === undefined ||
    value.length !== expected.length ||
    value.length > 100_000
  )
    return;
  const expectedIds = new Set(expected);
  const results: Readonly<{
    branchId: `sha256:${string}`;
    hits: number;
  }>[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isPlainDataRecord(raw) || !hasExactKeys(raw, ["branchId", "hits"]))
      return;
    const branchId = digest(raw["branchId"]);
    const hits = count(raw["hits"]);
    if (
      branchId === undefined ||
      !expectedIds.has(branchId) ||
      seen.has(branchId) ||
      hits === undefined
    )
      return;
    seen.add(branchId);
    results.push(Object.freeze({ branchId, hits }));
  }
  return Object.freeze(results);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function count(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 10_000_000
    ? value
    : undefined;
}

function digest(value: unknown): `sha256:${string}` | undefined {
  return typeof value === "string" && digestPattern.test(value)
    ? (value as `sha256:${string}`)
    : undefined;
}
