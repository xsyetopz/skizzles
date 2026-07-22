import { types } from "node:util";
import { digestValue } from "../digest.ts";
import type {
  MigrationFinding,
  MigrationLinter,
  MigrationLintReceipt,
  MigrationLintResult,
  MigrationOperation,
  MigrationPhase,
  MigrationSource,
} from "./contracts.ts";
import { parseMigrationSource, phaseRank } from "./parser.ts";

const AUTHENTIC_LINTERS = new WeakSet<object>();

function rejectedFinding(message: string): MigrationFinding {
  return { code: "INVALID_PATH", path: "<input>", message };
}

function validPhase(value: unknown): value is MigrationPhase {
  return value === "schema" || value === "backfill" || value === "rollback";
}

function validSource(value: unknown): value is MigrationSource {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return false;
  }
  const path = dataValue(value, "path");
  const bytes = dataValue(value, "bytes");
  const phase = dataValue(value, "phase");
  const order = dataValue(value, "order");
  const identity = dataValue(value, "identity");
  return (
    typeof path === "string" &&
    bytes instanceof Uint8Array &&
    validPhase(phase) &&
    typeof order === "number" &&
    (identity === undefined || typeof identity === "string")
  );
}

function dataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor !== undefined && "value" in descriptor) {
    return descriptor.value;
  }
}

function normalizeSource(value: unknown): MigrationSource | undefined {
  if (!validSource(value)) {
    return;
  }
  const path = dataValue(value, "path");
  const bytes = dataValue(value, "bytes");
  const phase = dataValue(value, "phase");
  const order = dataValue(value, "order");
  const identity = dataValue(value, "identity");
  if (
    typeof path !== "string" ||
    !(bytes instanceof Uint8Array) ||
    !validPhase(phase) ||
    typeof order !== "number" ||
    (identity !== undefined && typeof identity !== "string")
  ) {
    return;
  }
  return Object.freeze({
    path,
    bytes: new Uint8Array(bytes),
    phase,
    order,
    ...(typeof identity === "string" ? { identity } : {}),
  });
}

function sortSources(sources: readonly MigrationSource[]): MigrationSource[] {
  return [...sources].sort(
    (left, right) =>
      left.order - right.order || left.path.localeCompare(right.path),
  );
}

function makeReceipt(
  sources: readonly MigrationSource[],
  operations: MigrationLintReceipt["operations"],
  findings: readonly MigrationFinding[],
): MigrationLintReceipt {
  const sourceDigest = digestValue(
    sources.map((source) => ({
      path: source.path,
      phase: source.phase,
      order: source.order,
      bytes: digestValue(Array.from(source.bytes)),
    })),
  );
  const phaseOrder = sources.map((source) => source.phase);
  const accepted = findings.length === 0;
  const receiptDigest = digestValue({
    accepted,
    candidateDigest: sourceDigest,
    operations,
    findings,
    phaseOrder,
  });
  return Object.freeze({
    accepted,
    candidateDigest: sourceDigest,
    operations: Object.freeze([...operations]),
    findings: Object.freeze([...findings]),
    phaseOrder: Object.freeze([...phaseOrder]),
    receiptDigest,
  });
}

function lintSources(sources: readonly MigrationSource[]): MigrationLintResult {
  const findings: MigrationFinding[] = [];
  const operations: MigrationOperation[] = [];
  if (sources.length === 0) {
    findings.push(rejectedFinding("at least one migration source is required"));
  }
  if (!sources.every(validSource)) {
    findings.push(
      rejectedFinding(
        "migration source must contain path, Uint8Array bytes, phase, and order",
      ),
    );
  }
  const normalizedSources = sources.map(normalizeSource);
  const validSources = normalizedSources.filter(
    (source): source is MigrationSource => source !== undefined,
  );
  const ordered = sortSources(validSources);
  const seenPhases = new Set<MigrationPhase>();
  const seenIdentities = new Set<string>();
  let previousOrder = -1;
  let previousRank = -1;
  for (const source of ordered) {
    if (source.order <= previousOrder) {
      findings.push({
        code: "INVALID_ORDER",
        path: source.path,
        message: "migration orders must be strictly increasing",
      });
    }
    previousOrder = source.order;
    const rank = phaseRank(source.phase);
    if (rank < previousRank) {
      findings.push({
        code: "INVALID_ORDER",
        path: source.path,
        message: "migration phases must be ordered schema, backfill, rollback",
      });
    }
    previousRank = Math.max(previousRank, rank);
    seenPhases.add(source.phase);
    const parsed = parseMigrationSource(source);
    findings.push(...parsed.findings);
    for (const operation of parsed.operations) {
      if (seenIdentities.has(operation.identity)) {
        findings.push({
          code: "DUPLICATE_IDENTITY",
          path: operation.path,
          message: "operation identity is duplicated",
          statementIndex: operation.statementIndex,
        });
      }
      seenIdentities.add(operation.identity);
      operations.push(operation);
    }
  }
  for (const phase of ["schema", "backfill", "rollback"] as const) {
    if (!seenPhases.has(phase)) {
      findings.push({
        code: "MISSING_PHASE",
        path: "<input>",
        message: `${phase} phase is required`,
      });
    }
  }
  const receipt = makeReceipt(ordered, operations, findings);
  return receipt.accepted ? { ok: true, receipt } : { ok: false, receipt };
}

export function createMigrationLinter(): MigrationLinter {
  const linter: MigrationLinter = Object.freeze({
    lint: (sources: readonly MigrationSource[]) => {
      try {
        return lintSources(sources);
      } catch {
        const receipt = makeReceipt(
          [],
          [],
          [rejectedFinding("malformed migration input")],
        );
        return { ok: false, receipt };
      }
    },
  });
  AUTHENTIC_LINTERS.add(linter);
  return linter;
}

export function isMigrationLinter(value: unknown): value is MigrationLinter {
  return (
    typeof value === "object" && value !== null && AUTHENTIC_LINTERS.has(value)
  );
}

export function lintMigrationCandidates(
  sources: readonly MigrationSource[],
): MigrationLintResult {
  return createMigrationLinter().lint(sources);
}
