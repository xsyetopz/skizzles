import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReflexionLocalDatabase,
  isReflexionMemoryQuery,
  isReflexionMemoryRecorder,
} from "../src/index.ts";

const evidenceDigest = `sha256:${"a".repeat(64)}` as const;
const skillDigest = `sha256:${"b".repeat(64)}` as const;

describe("local Reflexion SQLite database", () => {
  it("persists failures and exposes separate read-only and write-only facades", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-reflexion-"));
    const databasePath = join(root, "memory.sqlite3");
    try {
      const created = createReflexionLocalDatabase(
        Object.freeze({ databasePath }),
      );
      if (created.status !== "created") {
        throw new Error(created.code);
      }
      expect(isReflexionMemoryQuery(created.query)).toBe(true);
      expect(isReflexionMemoryRecorder(created.recorder)).toBe(true);
      expect("recordFailure" in created.query).toBe(false);
      expect("snapshot" in created.recorder).toBe(false);

      await created.recorder.recordFailure({
        origin: { taskId: "task-origin", runId: "run-origin" },
        failure: {
          kind: "verification-failure",
          summary: "Verification rejected the candidate.",
          evidenceDigests: [evidenceDigest],
        },
        critique: {
          cause: "A required invariant was omitted.",
          correction: "Restore the invariant before retrying.",
          prevention: "Keep the invariant in protected context.",
        },
        skillReferences: [
          {
            kind: "external-skill-directory",
            access: "read-only",
            directoryId: "verification-guidance",
            relativeSkillPath: "verification/SKILL.md",
            revisionDigest: skillDigest,
          },
        ],
      });

      expect((await stat(databasePath)).isFile()).toBe(true);
      const current = await created.query.snapshot({
        currentTaskId: "task-origin",
        currentRunId: "run-next",
      });
      expect(current.records).toHaveLength(0);
      const later = await created.query.snapshot({
        currentTaskId: "task-next",
        currentRunId: "run-next",
      });
      expect(later.records).toHaveLength(1);
      expect(later.records[0]?.failure.kind).toBe("verification-failure");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects ambient, relative, mutable, and non-database paths", () => {
    for (const input of [
      Object.freeze({ databasePath: "memory.sqlite3" }),
      Object.freeze({ databasePath: "/tmp/memory.json" }),
      { databasePath: "/tmp/memory.sqlite3" },
      Object.freeze({}),
    ]) {
      expect(createReflexionLocalDatabase(input)).toEqual({
        status: "rejected",
        code: "INVALID_LOCAL_DATABASE_CONFIG",
      });
    }
  });
});
