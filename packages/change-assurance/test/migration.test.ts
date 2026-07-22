// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import {
  createMigrationLinter,
  isMigrationLinter,
  type MigrationSource,
  tokenizeSql,
} from "../src/index.ts";

function source(
  path: string,
  phase: MigrationSource["phase"],
  order: number,
  sql: string,
): MigrationSource {
  return Object.freeze({
    path,
    phase,
    order,
    bytes: new TextEncoder().encode(sql),
  });
}

const complete = Object.freeze([
  source(
    "src/data/001-schema.sql",
    "schema",
    1,
    "CREATE TABLE users (id integer);",
  ),
  source(
    "src/data/002-backfill.sql",
    "backfill",
    2,
    "UPDATE users SET id = id WHERE id IS NOT NULL;",
  ),
  source("src/data/003-rollback.sql", "rollback", 3, "DROP TABLE users;"),
]);

describe("migration assurance", () => {
  it("tokenizes comments and quoted semicolons structurally", () => {
    const result = tokenizeSql(
      "-- note\nCREATE TABLE users (name text default 'a;b');",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.tokens.map((token) => token.value)).toContain("CREATE");
    expect(result.tokens.map((token) => token.value)).toContain("a;b");
    const dollarQuoted = tokenizeSql(
      "CREATE TYPE status AS ENUM ($$ready;steady$$);",
    );
    expect(dollarQuoted.ok).toBe(true);
    if (dollarQuoted.ok) {
      expect(dollarQuoted.tokens.map((token) => token.value)).toContain(
        "ready;steady",
      );
    }
  });

  it("accepts ordered schema, backfill, and rollback phases", () => {
    const linter = createMigrationLinter();
    expect(isMigrationLinter(linter)).toBe(true);
    const result = linter.lint(complete);
    expect(result.ok).toBe(true);
    expect(result.receipt.operations).toHaveLength(3);
    expect(result.receipt.receiptDigest.startsWith("sha256:")).toBe(true);
  });

  it("rejects direct alter and lock statements", () => {
    const result = createMigrationLinter().lint([
      source(
        "src/data/001-schema.sql",
        "schema",
        1,
        "ALTER TABLE users ADD COLUMN name text;",
      ),
      source(
        "src/data/002-backfill.sql",
        "backfill",
        2,
        "UPDATE users SET id = id WHERE id IS NOT NULL;",
      ),
      source(
        "src/data/003-rollback.sql",
        "rollback",
        3,
        "LOCK TABLE users; DROP TABLE users;",
      ),
    ]);
    expect(result.ok).toBe(false);
    expect(result.receipt.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["ALTER_STATEMENT", "LOCK_STATEMENT"]),
    );
  });

  it("rejects missing phases, unsafe backfills, and cascades", () => {
    const result = createMigrationLinter().lint([
      source(
        "src/data/001-schema.sql",
        "schema",
        1,
        "CREATE TABLE users (id integer);",
      ),
      source(
        "src/data/002-backfill.sql",
        "backfill",
        2,
        "UPDATE users SET id = id;",
      ),
      source(
        "src/data/003-rollback.sql",
        "rollback",
        3,
        "DROP TABLE users CASCADE;",
      ),
    ]);
    expect(result.ok).toBe(false);
    expect(result.receipt.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["UNSAFE_BACKFILL", "ROLLBACK_CASCADE"]),
    );
  });

  it("rejects forged identities and paths outside src/data", () => {
    const schema = complete[0];
    const backfill = complete[1];
    const rollback = complete[2];
    if (
      schema === undefined ||
      backfill === undefined ||
      rollback === undefined
    ) {
      throw new Error("fixture incomplete");
    }
    const forged = { ...schema, identity: "schema:forged" };
    const result = createMigrationLinter().lint([forged, backfill, rollback]);
    expect(result.ok).toBe(false);
    expect(result.receipt.findings.map((finding) => finding.code)).toContain(
      "IDENTITY_MISMATCH",
    );
    const outside = createMigrationLinter().lint([
      source(
        "src/data/001-schema.sql",
        "schema",
        1,
        "CREATE TABLE users (id integer);",
      ),
      source(
        "src/data/002-backfill.sql",
        "backfill",
        2,
        "UPDATE users SET id = id WHERE id IS NOT NULL;",
      ),
      source("migrations/003-rollback.sql", "rollback", 3, "DROP TABLE users;"),
    ]);
    expect(outside.ok).toBe(false);
    expect(outside.receipt.findings.map((finding) => finding.code)).toContain(
      "INVALID_PATH",
    );
  });

  it("fails closed on proxy and accessor sources without executing them", () => {
    let executed = false;
    const accessor = Object.defineProperty(
      {
        path: "src/data/001-schema.sql",
        bytes: new TextEncoder().encode("CREATE TABLE users (id integer);"),
        phase: "schema" as const,
        order: 1,
      },
      "phase",
      {
        get: () => {
          executed = true;
          return "schema";
        },
        enumerable: true,
      },
    );
    const result = createMigrationLinter().lint([
      accessor,
      ...complete.slice(1),
    ]);
    expect(result.ok).toBe(false);
    expect(executed).toBe(false);
    const proxy = new Proxy(accessor, {
      get: () => {
        executed = true;
        return "schema";
      },
    });
    const proxied = createMigrationLinter().lint([proxy, ...complete.slice(1)]);
    expect(proxied.ok).toBe(false);
    expect(executed).toBe(false);
  });
});
