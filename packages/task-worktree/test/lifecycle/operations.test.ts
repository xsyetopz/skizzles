// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { afterEach, describe, expect, it } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isTaskWorktree, isTaskWorktreeReceipt } from "../../src/index.ts";
import {
  cleanupFixtures,
  createApprovalEvidence,
  createAuthority,
  createFixture,
  gitExit,
  gitOutput,
  prepareInput,
  runGit,
  worktreeAllocation,
  worktreePaths,
} from "./support.ts";

afterEach(cleanupFixtures);

describe("task-scoped Git worktree lifecycle operations", () => {
  it("allocates a deterministic isolated branch and closes only the clean owned worktree", async () => {
    const fixture = await createFixture();
    runGit(fixture.repository, ["branch", "foreign"]);
    const authority = createAuthority(fixture);
    expect(isTaskWorktree(authority)).toBe(true);
    const prepared = await authority.prepare(prepareInput("alpha.1"));
    if (prepared.status === "rejected") throw new Error(prepared.code);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(Object.keys(prepared.session)).toEqual(["schema"]);
    expect(prepared.receipt.taskId).toBe("alpha.1");
    expect(prepared.receipt.branchName).toMatch(
      /^codex\/task-alpha-1-[0-9a-f]{16}$/u,
    );
    expect(Object.isFrozen(prepared.session)).toBe(true);
    expect(Object.isFrozen(prepared.receipt)).toBe(true);
    expect(Object.isFrozen(prepared.receipt.diff)).toBe(true);
    expect(isTaskWorktreeReceipt(prepared.receipt)).toBe(true);

    expect(
      await authority.revalidate(
        Object.freeze({ version: 1 as const, session: prepared.session }),
      ),
    ).toMatchObject({ status: "valid" });
    expect(
      await authority.run(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          profileIds: Object.freeze(["status"]),
        }),
      ),
    ).toMatchObject({ status: "ran" });

    const allocation = worktreeAllocation(fixture.repository);
    expect(allocation.branch).toMatch(/^codex\/task-alpha-1-[0-9a-f]{16}$/u);
    expect(await readFile(join(allocation.root, "tracked.txt"), "utf8")).toBe(
      "candidate\n",
    );
    expect(gitOutput(fixture.repository, ["status", "--porcelain=v1"])).toBe(
      "",
    );

    expect(
      await authority.commit(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          permit: `sha256:${"b".repeat(64)}`,
        }),
      ),
    ).toEqual({ status: "rejected", code: "APPROVAL_REJECTED" });
    const authorized = await authority.authorize(
      Object.freeze({
        version: 1 as const,
        session: prepared.session,
        approvalEvidence: createApprovalEvidence(),
      }),
    );
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    expect(
      await authority.commit(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          permit: Object.freeze({
            schema: authorized.permit.schema,
            permitDigest: authorized.permit.permitDigest,
          }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "APPROVAL_REJECTED" });
    const committed = await authority.commit(
      Object.freeze({
        version: 1 as const,
        session: prepared.session,
        permit: authorized.permit,
      }),
    );
    if (committed.status === "rejected") {
      throw new Error(committed.code);
    }
    expect(committed.status).toBe("committed");

    const closed = await authority.close(
      Object.freeze({ version: 1 as const, session: prepared.session }),
    );
    expect(closed.status).toBe("closed");
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(await readdir(fixture.worktreeParent)).toEqual([]);
    expect(
      gitExit(fixture.repository, [
        "show-ref",
        "--verify",
        `refs/heads/${allocation.branch}`,
      ]),
    ).toBe(128);
    expect(
      gitExit(fixture.repository, [
        "show-ref",
        "--verify",
        "refs/heads/foreign",
      ]),
    ).toBe(0);
  });

  it("preserves unrelated canonical dirt while allocating from captured HEAD", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repository, "untracked.txt"), "dirty\n");
    const result = await createAuthority(fixture).prepare(
      prepareInput("dirty-root"),
    );
    expect(result.status).toBe("prepared");
    expect(
      await readFile(join(fixture.repository, "untracked.txt"), "utf8"),
    ).toBe("dirty\n");
    expect(worktreePaths(fixture.repository)).toHaveLength(2);
  });

  it("rejects duplicate task identity while its deterministic allocation is active", async () => {
    const fixture = await createFixture();
    const authority = createAuthority(fixture);
    const input = prepareInput("replay");
    const prepared = await authority.prepare(input);
    if (prepared.status !== "prepared")
      throw new Error("fixture allocation failed");
    expect(await authority.prepare(input)).toEqual({
      status: "rejected",
      code: "ALREADY_PREPARED",
    });
    expect(worktreePaths(fixture.repository)).toHaveLength(2);
  });

  it("closes an exact uncommitted candidate without leaking owned roots or branch", async () => {
    const fixture = await createFixture();
    const authority = createAuthority(fixture);
    const prepared = await authority.prepare(prepareInput("abandoned"));
    if (prepared.status !== "prepared") {
      throw new Error("fixture allocation failed");
    }
    const allocation = worktreeAllocation(fixture.repository);
    expect(
      await authority.close(
        Object.freeze({ version: 1 as const, session: prepared.session }),
      ),
    ).toMatchObject({ status: "closed" });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(await readdir(fixture.worktreeParent)).toEqual([]);
    expect(
      gitExit(fixture.repository, [
        "show-ref",
        "--verify",
        `refs/heads/${allocation.branch}`,
      ]),
    ).toBe(128);
  });
});
