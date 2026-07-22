import { afterEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TaskWorktree,
  TaskWorktreeApprovalAuthorityRequest,
  TaskWorktreeSession,
} from "../../src/index.ts";
import {
  cleanupFixtures,
  createApprovalEvidence,
  createAuthority,
  createAuthorityWithApproval,
  createFixture,
  prepareInput,
  worktreeAllocation,
} from "./support.ts";

afterEach(cleanupFixtures);

describe("task-worktree promotion permits", () => {
  it("freezes nested approval arrays and rejects a replayed binding decision", async () => {
    const fixture = await createFixture();
    let firstBindingDigest: string | undefined;
    let observed: TaskWorktreeApprovalAuthorityRequest | undefined;
    const authority = createAuthorityWithApproval(
      fixture,
      Object.freeze({
        id: "approval-array-regression",
        authorize: (request: TaskWorktreeApprovalAuthorityRequest) => {
          observed ??= request;
          firstBindingDigest ??= request.binding.bindingDigest;
          return Object.freeze({
            status: "approved" as const,
            bindingDigest: firstBindingDigest,
            approvalDigest: `sha256:${"d".repeat(64)}` as const,
          });
        },
      }),
    );
    const first = await authority.prepare(prepareInput("array-first"));
    const second = await authority.prepare(prepareInput("array-second"));
    if (first.status !== "prepared" || second.status !== "prepared") {
      throw new Error("parallel prepare failed");
    }
    await runValidation(authority, first.session);
    await runValidation(authority, second.session);
    expect(
      await authority.authorize(
        Object.freeze({
          version: 1 as const,
          session: first.session,
          approvalEvidence: Object.freeze({}),
        }),
      ),
    ).toMatchObject({ status: "authorized" });
    const binding = observed?.binding;
    if (binding === undefined) throw new Error("approval binding not observed");
    expect(Object.isFrozen(binding)).toBe(true);
    for (const values of [
      binding.runProfileIds,
      binding.runOutcomeDigests,
      binding.verificationProfileIds,
      binding.verificationReceiptDigests,
    ]) {
      expect(Object.isFrozen(values)).toBe(true);
      expect(Reflect.set(values, 0, "forged")).toBe(false);
    }
    expect(
      await authority.authorize(
        Object.freeze({
          version: 1 as const,
          session: second.session,
          approvalEvidence: Object.freeze({}),
        }),
      ),
    ).toEqual({ status: "rejected", code: "APPROVAL_REJECTED" });
  });

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
