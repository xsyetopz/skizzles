// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { afterEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskWorktree, TaskWorktreeSession } from "../../src/index.ts";
import {
  cleanupFixtures,
  createApprovalEvidence,
  createAuthority,
  createFixture,
  prepareInput,
  worktreeAllocation,
} from "./support.ts";

afterEach(cleanupFixtures);

describe("task-worktree promotion permits", () => {
  it("rejects arbitrary approval facts and forged permit lookalikes", async () => {
    const authority = createAuthority(await createFixture());
    const prepared = await authority.prepare(prepareInput("permit-forgery"));
    if (prepared.status !== "prepared") throw new Error("prepare failed");
    expect(
      await authority.authorize(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          approvalEvidence: Object.freeze({ kind: "approved" }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "APPROVAL_REJECTED" });
    expect(
      await authority.commit(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          permit: `sha256:${"b".repeat(64)}`,
        }),
      ),
    ).toEqual({ status: "rejected", code: "APPROVAL_REJECTED" });
    expect(
      await authority.authorize(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          approvalEvidence: createApprovalEvidence(),
        }),
      ),
    ).toEqual({ status: "rejected", code: "APPROVAL_REJECTED" });
    await runValidation(authority, prepared.session);
    const authorized = await authority.authorize(
      Object.freeze({
        version: 1 as const,
        session: prepared.session,
        approvalEvidence: createApprovalEvidence(),
      }),
    );
    if (authorized.status !== "authorized") throw new Error("authorize failed");
    expect(Object.isFrozen(authorized.permit)).toBe(true);
    expect(
      await authority.commit(
        Object.freeze({
          version: 1 as const,
          session: prepared.session,
          permit: Object.freeze({ ...authorized.permit }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "APPROVAL_REJECTED" });
  });

  it("binds the authentic permit to its session and exact revalidated candidate", async () => {
    const fixture = await createFixture();
    const authority = createAuthority(fixture);
    const first = await authority.prepare(prepareInput("permit-first"));
    const second = await authority.prepare(prepareInput("permit-second"));
    if (first.status !== "prepared" || second.status !== "prepared") {
      throw new Error("parallel prepare failed");
    }
    await runValidation(authority, first.session);
    await runValidation(authority, second.session);
    const authorized = await authority.authorize(
      Object.freeze({
        version: 1 as const,
        session: first.session,
        approvalEvidence: createApprovalEvidence(),
      }),
    );
    if (authorized.status !== "authorized") throw new Error("authorize failed");
    expect(
      await authority.commit(
        Object.freeze({
          version: 1 as const,
          session: second.session,
          permit: authorized.permit,
        }),
      ),
    ).toEqual({ status: "rejected", code: "APPROVAL_REJECTED" });
    expect(
      await authority.run(
        Object.freeze({
          version: 1 as const,
          session: first.session,
          profileIds: Object.freeze([]),
        }),
      ),
    ).toMatchObject({ status: "ran" });
    expect(
      await authority.commit(
        Object.freeze({
          version: 1 as const,
          session: first.session,
          permit: authorized.permit,
        }),
      ),
    ).toEqual({ status: "rejected", code: "APPROVAL_REJECTED" });
    const firstRoot = worktreeAllocation(fixture.repository).root;
    await writeFile(join(firstRoot, "tracked.txt"), "drifted\n");
    expect(
      await authority.commit(
        Object.freeze({
          version: 1 as const,
          session: first.session,
          permit: authorized.permit,
        }),
      ),
    ).toEqual({ status: "rejected", code: "CANDIDATE_REJECTED" });
  });
});

async function runValidation(
  authority: TaskWorktree,
  session: TaskWorktreeSession,
): Promise<void> {
  const result = await authority.run(
    Object.freeze({
      version: 1 as const,
      session,
      profileIds: Object.freeze(["status"]),
    }),
  );
  if (result.status !== "ran") throw new Error("run failed");
}
