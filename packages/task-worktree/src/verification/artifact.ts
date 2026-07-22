import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { digestTaskWorktreeBytes, digestTaskWorktreeValue } from "../digest.ts";
import { isPlainDataRecord, isSafeRelativePath } from "../policy/value.ts";
import type { SandboxVerificationObjective } from "../sandbox/contract.ts";
import { sandboxVerificationObjectiveDigest } from "../sandbox/objective.ts";
import type {
  TaskWorktreeVerificationArtifactReceipt,
  TaskWorktreeVerificationProfile,
  TaskWorktreeVerificationReport,
} from "./contract.ts";
import { parseCoverageArtifactReport } from "./coverage-report.ts";

const reportIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
// biome-ignore lint/security/noSecrets: This is a public digest field name, not a credential.
const productionOverlayDigestKey = "productionOverlayDigest";

export async function prepareArtifactDestination(
  root: string,
  path: string,
): Promise<boolean> {
  if (!isSafeRelativePath(path)) return false;
  const parent = dirname(path);
  if (parent === ".") return true;
  let cursor = root;
  for (const segment of parent.split("/")) {
    cursor = join(cursor, segment);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if (!alreadyExists(error)) return false;
    }
    try {
      const metadata = await lstat(cursor);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        !within(root, await realpath(cursor))
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function readVerificationArtifact(
  root: string,
  profile: Readonly<{
    kind: TaskWorktreeVerificationProfile["kind"];
    artifact: Readonly<{
      schema: string;
      relativePath: string;
      maximumBytes: number;
    }>;
  }>,
  binding: Readonly<{
    objective: SandboxVerificationObjective;
    objectiveDigest: `sha256:${string}`;
  }>,
): Promise<TaskWorktreeVerificationArtifactReceipt | undefined> {
  if (
    binding.objectiveDigest !==
    sandboxVerificationObjectiveDigest(binding.objective)
  )
    return;
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") return;
  const target = join(root, profile.artifact.relativePath);
  let handle: FileHandle | undefined;
  try {
    const pathStat = await lstat(target);
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.nlink !== 1 ||
      pathStat.size <= 0 ||
      pathStat.size > profile.artifact.maximumBytes ||
      !within(root, await realpath(target))
    )
      return;
    handle = await open(target, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!sameFile(before, pathStat) || before.nlink !== 1) return;
    const bytes = await readExact(handle, before.size);
    const after = await handle.stat();
    const finalPathStat = await lstat(target);
    if (
      !(sameFile(before, after) && sameFile(after, finalPathStat)) ||
      after.size !== bytes.byteLength ||
      after.nlink !== 1
    )
      return;
    const report = parseArtifactJson(
      bytes,
      profile.artifact.schema,
      profile.kind,
      binding.objective,
    );
    if (report === undefined) return;
    const body = Object.freeze({
      schema: "skizzles.task-worktree/verification-artifact" as const,
      artifactSchema: profile.artifact.schema,
      byteLength: bytes.byteLength,
      contentDigest: digestTaskWorktreeBytes(bytes),
      objectiveDigest: binding.objectiveDigest,
      report,
    });
    return Object.freeze({
      ...body,
      receiptDigest: digestTaskWorktreeValue(body),
    });
  } catch {
    return void 0;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseArtifactJson(
  bytes: Uint8Array,
  expectedSchema: string,
  expectedKind: TaskWorktreeVerificationProfile["kind"],
  objective: SandboxVerificationObjective,
): TaskWorktreeVerificationReport | undefined {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch {
    return;
  }
  if (
    !isPlainDataRecord(raw) ||
    raw["schema"] !== expectedSchema ||
    !Object.hasOwn(raw, "result") ||
    Object.keys(raw).some((key) => key !== "schema" && key !== "result")
  )
    return;
  return parseReport(raw["result"], expectedKind, objective);
}

function parseReport(
  value: unknown,
  kind: TaskWorktreeVerificationProfile["kind"],
  objective: SandboxVerificationObjective,
): TaskWorktreeVerificationReport | undefined {
  if (
    !isPlainDataRecord(value) ||
    value["kind"] !== kind ||
    objective.kind !== kind
  )
    return;
  const outcome = parseOutcome(value["outcome"]);
  if (outcome === undefined) return;
  if (kind === "original-tests") {
    if (
      objective.kind !== "original-tests" ||
      !hasExactKeys(value, [
        "baselineTestManifestDigest",
        "containerEvidenceDigest",
        "containerImageDigest",
        "failedCount",
        "kind",
        "outcome",
        "passedCount",
        productionOverlayDigestKey,
        "testIds",
      ])
    )
      return;
    const passedCount = count(value["passedCount"]);
    const failedCount = count(value["failedCount"]);
    const testIds = ids(value["testIds"]);
    if (
      passedCount === undefined ||
      failedCount === undefined ||
      testIds === undefined ||
      value["baselineTestManifestDigest"] !==
        objective.baselineTestManifestDigest ||
      value[productionOverlayDigestKey] !== objective.productionOverlayDigest ||
      value["containerImageDigest"] !== objective.containerImageDigest ||
      value["containerEvidenceDigest"] !== objective.containerEvidenceDigest ||
      passedCount + failedCount !== testIds.length ||
      (outcome === "passed") !== (failedCount === 0)
    )
      return;
    return Object.freeze({
      kind,
      outcome,
      passedCount,
      failedCount,
      testIds,
      baselineTestManifestDigest: objective.baselineTestManifestDigest,
      productionOverlayDigest: objective.productionOverlayDigest,
      containerImageDigest: objective.containerImageDigest,
      containerEvidenceDigest: objective.containerEvidenceDigest,
    });
  }
  if (kind === "mutation") {
    if (
      !hasExactKeys(value, ["inventoryDigest", "kind", "outcome", "outcomes"])
    )
      return;
    const inventoryDigest = digest(value["inventoryDigest"]);
    const outcomes = mutationOutcomes(value["outcomes"]);
    if (
      objective.kind !== "mutation" ||
      inventoryDigest === undefined ||
      inventoryDigest !== objective.inventoryDigest ||
      outcomes === undefined ||
      outcomes.length === 0 ||
      !sameValues(
        outcomes.map(({ mutantId }) => mutantId),
        objective.mutantIds,
      ) ||
      (outcome === "passed") !==
        outcomes.every((entry) => entry.outcome === "killed")
    )
      return;
    return Object.freeze({ kind, outcome, inventoryDigest, outcomes });
  }
  if (kind === "property") {
    if (
      !hasExactKeys(value, [
        "extremeVectorInventoryDigest",
        "kind",
        "outcome",
        "properties",
        "requiredCaseCount",
        "seedScheduleDigest",
      ])
    )
      return;
    const seedScheduleDigest = digest(value["seedScheduleDigest"]);
    const requiredCaseCount = count(value["requiredCaseCount"]);
    const extremeVectorInventoryDigest = digest(
      value["extremeVectorInventoryDigest"],
    );
    const properties = propertyResults(value["properties"]);
    if (
      objective.kind !== "property" ||
      seedScheduleDigest === undefined ||
      seedScheduleDigest !== objective.seedScheduleDigest ||
      requiredCaseCount === undefined ||
      requiredCaseCount !== objective.requiredCaseCount ||
      extremeVectorInventoryDigest === undefined ||
      extremeVectorInventoryDigest !== objective.extremeVectorInventoryDigest ||
      properties === undefined ||
      properties.length === 0 ||
      properties.some(
        ({
          completed,
          executedCases,
          executedRandomCases,
          executedExtremeCases,
          executedExtremeVectorDigests,
        }) =>
          !completed ||
          executedCases !== requiredCaseCount ||
          executedRandomCases !== objective.requiredRandomFuzzCaseCount ||
          executedExtremeCases !== objective.requiredExtremeVectorCount ||
          executedCases !== executedRandomCases + executedExtremeCases ||
          !sameValues(
            executedExtremeVectorDigests,
            objective.requiredExtremeVectorDigests,
          ),
      ) ||
      !sameMembers(
        properties.flatMap(({ nodeIds }) => nodeIds),
        objective.nodeIds,
      ) ||
      !sameMembers(
        properties.flatMap(({ branchIds }) => branchIds),
        objective.branchIds,
      ) ||
      (outcome === "passed") !==
        properties.every((entry) => entry.counterexampleDigest === null)
    )
      return;
    return Object.freeze({
      kind,
      outcome,
      seedScheduleDigest,
      requiredCaseCount,
      extremeVectorInventoryDigest,
      properties,
    });
  }
  return objective.kind === "coverage"
    ? parseCoverageArtifactReport(value, outcome, objective)
    : undefined;
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSet = new Set(left);
  return (
    leftSet.size === right.length && right.every((value) => leftSet.has(value))
  );
}

function mutationOutcomes(
  value: unknown,
):
  | Extract<TaskWorktreeVerificationReport, { kind: "mutation" }>["outcomes"]
  | undefined {
  if (!Array.isArray(value) || value.length > 100_000) return;
  const results: {
    mutantId: `sha256:${string}`;
    outcome: "invalid" | "killed" | "survived" | "timeout";
    evidenceDigest: `sha256:${string}`;
  }[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (
      !(
        isPlainDataRecord(raw) &&
        hasExactKeys(raw, ["evidenceDigest", "mutantId", "outcome"])
      )
    )
      return;
    const mutantId = digest(raw["mutantId"]);
    const evidenceDigest = digest(raw["evidenceDigest"]);
    const mutantOutcome = raw["outcome"];
    if (
      mutantId === undefined ||
      seen.has(mutantId) ||
      evidenceDigest === undefined ||
      !(
        mutantOutcome === "invalid" ||
        mutantOutcome === "killed" ||
        mutantOutcome === "survived" ||
        mutantOutcome === "timeout"
      )
    )
      return;
    seen.add(mutantId);
    results.push(
      Object.freeze({ mutantId, outcome: mutantOutcome, evidenceDigest }),
    );
  }
  return Object.freeze(results);
}

function propertyResults(
  value: unknown,
):
  | Extract<TaskWorktreeVerificationReport, { kind: "property" }>["properties"]
  | undefined {
  if (!Array.isArray(value) || value.length > 4096) return;
  const results: {
    propertyId: string;
    nodeIds: readonly `sha256:${string}`[];
    branchIds: readonly `sha256:${string}`[];
    completed: true;
    executedCases: number;
    executedRandomCases: number;
    executedExtremeCases: number;
    executedExtremeVectorDigests: readonly `sha256:${string}`[];
    counterexampleDigest: `sha256:${string}` | null;
  }[] = [];
  const propertyIds = new Set<string>();
  for (const raw of value) {
    if (
      !(
        isPlainDataRecord(raw) &&
        hasExactKeys(raw, [
          "branchIds",
          "completed",
          "counterexampleDigest",
          "executedCases",
          "executedExtremeCases",
          "executedExtremeVectorDigests",
          "executedRandomCases",
          "nodeIds",
          "propertyId",
        ])
      )
    )
      return;
    const propertyId = identifier(raw["propertyId"]);
    const nodeIds = digests(raw["nodeIds"]);
    const branchIds = digests(raw["branchIds"]);
    const completed = raw["completed"];
    const executedCases = count(raw["executedCases"]);
    const executedRandomCases = count(raw["executedRandomCases"]);
    const executedExtremeCases = count(raw["executedExtremeCases"]);
    const executedExtremeVectorDigests = digests(
      raw["executedExtremeVectorDigests"],
    );
    const rawCounterexample = raw["counterexampleDigest"];
    const counterexampleDigest =
      rawCounterexample === null ? null : digest(rawCounterexample);
    if (
      propertyId === undefined ||
      propertyIds.has(propertyId) ||
      nodeIds === undefined ||
      branchIds === undefined ||
      completed !== true ||
      executedCases === undefined ||
      executedCases === 0 ||
      executedRandomCases === undefined ||
      executedExtremeCases === undefined ||
      executedExtremeVectorDigests === undefined ||
      (rawCounterexample !== null && counterexampleDigest === undefined)
    )
      return;
    propertyIds.add(propertyId);
    results.push(
      Object.freeze({
        propertyId,
        nodeIds,
        branchIds,
        completed,
        executedCases,
        executedRandomCases,
        executedExtremeCases,
        executedExtremeVectorDigests,
        counterexampleDigest: counterexampleDigest ?? null,
      }),
    );
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

function parseOutcome(value: unknown): "failed" | "passed" | undefined {
  return value === "failed" || value === "passed" ? value : undefined;
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

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && reportIdPattern.test(value)
    ? value
    : undefined;
}

function ids(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 4096) return;
  const parsed: string[] = [];
  let previous = "";
  for (const id of value) {
    if (typeof id !== "string" || !reportIdPattern.test(id) || id <= previous)
      return;
    previous = id;
    parsed.push(id);
  }
  return Object.freeze(parsed);
}

function digests(value: unknown): readonly `sha256:${string}`[] | undefined {
  if (!Array.isArray(value) || value.length > 100_000) return;
  const parsed: `sha256:${string}`[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const valueDigest = digest(raw);
    if (valueDigest === undefined || seen.has(valueDigest)) return;
    seen.add(valueDigest);
    parsed.push(valueDigest);
  }
  return Object.freeze(parsed);
}

async function readExact(
  handle: FileHandle,
  size: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead <= 0) throw new Error("short artifact read");
    offset += result.bytesRead;
  }
  return bytes;
}

function sameFile(
  left: { dev: number; ino: number; size: number },
  right: { dev: number; ino: number; size: number },
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.size === right.size
  );
}

function within(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" || !(fromRoot.startsWith("..") || fromRoot.startsWith("/"))
  );
}

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
