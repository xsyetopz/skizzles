import { describe, expect, it } from "bun:test";
import { invokeExtension } from "../src/extension.ts";
import { createMigrationConfigurationSecretsExtension } from "../src/migration/authority.ts";

const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;
const bytes = (sql: string): readonly number[] =>
  Array.from(new TextEncoder().encode(sql));

describe("migration/configuration/secrets extension", () => {
  it("runs the real linter and scanner through the core extension boundary", async () => {
    const created = createMigrationConfigurationSecretsExtension({
      id: "migration-gate",
      version: "1.0.0",
      configurationPaths: [],
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      return;
    }
    const result = await invokeExtension(created.extension, {
      requestDigest: digest("a"),
      repositoryId: "repo",
      treeDigest: digest("b"),
      baselineDigest: digest("c"),
      declarationDigest: digest("d"),
      domain: "migration-configuration-secrets",
      plan: {
        migrations: [
          { path: "src/data/001-schema.sql", phase: "schema", order: 1 },
          { path: "src/data/002-backfill.sql", phase: "backfill", order: 2 },
          { path: "src/data/003-rollback.sql", phase: "rollback", order: 3 },
        ],
      },
      targets: [
        {
          path: "src/data/001-schema.sql",
          operation: "write",
          baselineBytes: [],
          candidateBytes: bytes("CREATE TABLE users (id integer);"),
        },
        {
          path: "src/data/002-backfill.sql",
          operation: "write",
          baselineBytes: [],
          candidateBytes: bytes(
            "UPDATE users SET id = id WHERE id IS NOT NULL;",
          ),
        },
        {
          path: "src/data/003-rollback.sql",
          operation: "write",
          baselineBytes: [],
          candidateBytes: bytes("DROP TABLE users;"),
        },
      ],
    });
    expect(result.status).toBe("accepted");
  });

  it("rejects a migration that omits a declared data target or emits a credential", async () => {
    const created = createMigrationConfigurationSecretsExtension({
      id: "migration-gate",
      version: "1.0.0",
      configurationPaths: [],
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      return;
    }
    const result = await invokeExtension(created.extension, {
      requestDigest: digest("a"),
      repositoryId: "repo",
      treeDigest: digest("b"),
      baselineDigest: digest("c"),
      declarationDigest: digest("d"),
      domain: "migration-configuration-secrets",
      plan: {
        migrations: [
          { path: "src/data/001-schema.sql", phase: "schema", order: 1 },
        ],
      },
      targets: [
        {
          path: "src/data/001-schema.sql",
          operation: "write",
          baselineBytes: [],
          candidateBytes: bytes("ALTER TABLE users ADD COLUMN token text;"),
        },
      ],
    });
    expect(result.status).toBe("rejected");
  });
});
