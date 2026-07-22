import { digestBytes, digestValue } from "../digest.ts";
import type {
  MigrationFinding,
  MigrationOperation,
  MigrationPhase,
} from "./contracts.ts";
import {
  canonicalTokens,
  hasToken,
  splitStatements,
  statementKind,
} from "./statements.ts";
import { tokenizeSql } from "./tokenizer.ts";

const PHASE_RANK: Record<MigrationPhase, number> = {
  schema: 0,
  backfill: 1,
  rollback: 2,
};

function finding(
  code: MigrationFinding["code"],
  path: string,
  message: string,
  statementIndex?: number,
): MigrationFinding {
  return statementIndex === undefined
    ? { code, path, message }
    : { code, path, message, statementIndex };
}

export function parseMigrationSource(source: {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly phase: MigrationPhase;
  readonly order: number;
  readonly identity?: string;
}): {
  readonly operations: readonly MigrationOperation[];
  readonly findings: readonly MigrationFinding[];
} {
  const findings: MigrationFinding[] = [];
  if (
    !source.path.startsWith("src/data/") ||
    source.path.includes("\\") ||
    source.path.includes("../") ||
    source.path.endsWith("/")
  ) {
    findings.push(
      finding(
        "INVALID_PATH",
        source.path,
        "migration path must be a relative src/data/** file",
      ),
    );
  }
  if (!Number.isSafeInteger(source.order) || source.order < 0) {
    findings.push(
      finding(
        "INVALID_ORDER",
        source.path,
        "migration order must be a non-negative safe integer",
      ),
    );
  }
  let sql: string;
  try {
    sql = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(source.bytes),
    );
  } catch {
    findings.push(
      finding(
        "TOKENIZATION_ERROR",
        source.path,
        "migration bytes are not valid UTF-8",
      ),
    );
    return { operations: [], findings };
  }
  const tokenized = tokenizeSql(sql);
  if (!tokenized.ok) {
    findings.push(
      finding(
        "TOKENIZATION_ERROR",
        source.path,
        `${tokenized.message} at byte ${tokenized.offset}`,
      ),
    );
    return { operations: [], findings };
  }
  const statements = splitStatements(tokenized.tokens);
  if (statements.length === 0) {
    findings.push(
      finding(
        "EMPTY_MIGRATION",
        source.path,
        "migration must contain at least one SQL statement",
      ),
    );
    return { operations: [], findings };
  }
  const operations: MigrationOperation[] = [];
  for (const statement of statements) {
    const first = statement.tokens[0]?.value;
    const kind = statementKind(statement.tokens);
    if (first === "ALTER") {
      findings.push(
        finding(
          "ALTER_STATEMENT",
          source.path,
          "direct ALTER statements are forbidden; use an additive schema operation",
          statement.statementIndex,
        ),
      );
      continue;
    }
    if (first === "LOCK" || hasToken(statement.tokens, "LOCK")) {
      findings.push(
        finding(
          "LOCK_STATEMENT",
          source.path,
          "explicit or embedded lock statements are forbidden",
          statement.statementIndex,
        ),
      );
      continue;
    }
    if (first === "TRUNCATE" || first === "DELETE") {
      findings.push(
        finding(
          "DESTRUCTIVE_STATEMENT",
          source.path,
          "destructive data statements are forbidden",
          statement.statementIndex,
        ),
      );
      continue;
    }
    if (kind === undefined) {
      findings.push(
        finding(
          "UNKNOWN_STATEMENT",
          source.path,
          `unsupported SQL statement ${first ?? "<empty>"}`,
          statement.statementIndex,
        ),
      );
      continue;
    }
    if (source.phase === "schema" && !kind.startsWith("create-")) {
      findings.push(
        finding(
          "UNEXPECTED_PHASE_OPERATION",
          source.path,
          `${kind} is not a schema-phase operation`,
          statement.statementIndex,
        ),
      );
      continue;
    }
    if (
      source.phase === "backfill" &&
      kind !== "update" &&
      kind !== "insert-select"
    ) {
      findings.push(
        finding(
          "UNEXPECTED_PHASE_OPERATION",
          source.path,
          `${kind} is not a backfill-phase operation`,
          statement.statementIndex,
        ),
      );
      continue;
    }
    if (source.phase === "rollback" && !kind.startsWith("drop-")) {
      findings.push(
        finding(
          "UNEXPECTED_PHASE_OPERATION",
          source.path,
          `${kind} is not a rollback-phase operation`,
          statement.statementIndex,
        ),
      );
      continue;
    }
    if (
      source.phase === "backfill" &&
      kind === "update" &&
      !hasToken(statement.tokens, "WHERE")
    ) {
      findings.push(
        finding(
          "UNSAFE_BACKFILL",
          source.path,
          "UPDATE backfills require a WHERE predicate",
          statement.statementIndex,
        ),
      );
      continue;
    }
    if (source.phase === "rollback" && hasToken(statement.tokens, "CASCADE")) {
      findings.push(
        finding(
          "ROLLBACK_CASCADE",
          source.path,
          "rollback drops may not cascade",
          statement.statementIndex,
        ),
      );
      continue;
    }
    const statementDigest = digestValue(canonicalTokens(statement.tokens));
    const identity = `${source.phase}:${source.path}:${source.order}:${statement.statementIndex}:${kind}:${statementDigest}`;
    if (source.identity !== undefined && source.identity !== identity) {
      findings.push(
        finding(
          "IDENTITY_MISMATCH",
          source.path,
          "caller identity does not match token-derived operation identity",
          statement.statementIndex,
        ),
      );
      continue;
    }
    operations.push({
      identity,
      kind,
      phase: source.phase,
      path: source.path,
      statementIndex: statement.statementIndex,
      digest: digestBytes(
        new TextEncoder().encode(canonicalTokens(statement.tokens)),
      ),
    });
  }
  return { operations, findings };
}

export function phaseRank(phase: MigrationPhase): number {
  return PHASE_RANK[phase];
}
