// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createTaskWorktree } from "../../src/index.ts";
import {
  cleanupFixtures,
  createAuthority,
  createFixture,
  gitExit,
  gitOutput,
  policyConfig,
  prepareInput,
  runGit,
  worktreeAllocation,
  worktreePaths,
} from "./support.ts";

afterEach(cleanupFixtures);

describe("task-scoped Git worktree lifecycle isolation", () => {
  it("retries partial cleanup without losing authentic session ownership", async () => {
    const fixture = await createFixture();
    const authority = createAuthority(fixture);
    const prepared = await authority.prepare(prepareInput("cleanup-retry"));
    if (prepared.status !== "prepared") {
      throw new Error("fixture allocation failed");
    }
    const writableName = (await readdir(fixture.worktreeParent)).find((name) =>
      name.endsWith("-writable"),
    );
    if (writableName === undefined) {
      throw new Error("missing writable root");
    }
    const writableRoot = join(fixture.worktreeParent, writableName);
    const redirect = join(fixture.root, "redirect");
    await rm(writableRoot, { recursive: true });
    await mkdir(redirect);
    await symlink(redirect, writableRoot);
    const action = Object.freeze({
      version: 1 as const,
      session: prepared.session,
    });
    expect(await authority.close(action)).toEqual({
      status: "rejected",
      code: "CLEANUP_INCOMPLETE",
    });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    await rm(writableRoot);
    await mkdir(writableRoot, { mode: 0o700 });
    expect(await authority.close(action)).toMatchObject({ status: "closed" });
    expect(await readdir(fixture.worktreeParent)).toEqual([]);
  });

  it("keeps distinct task IDs isolated in parallel worktrees", async () => {
    const fixture = await createFixture();
    const authority = createAuthority(fixture);
    const [first, second] = await Promise.all([
      authority.prepare(prepareInput("parallel-a")),
      authority.prepare(prepareInput("parallel-b")),
    ]);
    expect(first.status).toBe("prepared");
    expect(second.status).toBe("prepared");
    const allocations = worktreePaths(fixture.repository).filter(
      (path) => path !== fixture.repository,
    );
    expect(allocations).toHaveLength(2);
    expect(new Set(allocations).size).toBe(2);
    for (const root of allocations) {
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
        "candidate\n",
      );
    }
  });

  it("preserves the winning allocation when two authentic facades prepare the same task concurrently", async () => {
    const fixture = await createFixture();
    const first = createAuthority(fixture);
    const second = createAuthority(fixture);
    const input = prepareInput("cross-facade-race");
    const results = await Promise.all([
      first.prepare(input),
      second.prepare(input),
    ]);
    const winners = results.filter((result) => result.status === "prepared");
    const losers = results.filter((result) => result.status !== "prepared");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ status: "rejected" });
    const winner = winners[0];
    if (winner?.status !== "prepared") throw new Error("winner missing");
    let winningAuthority = first;
    let losingAuthority = second;
    if (results[0] !== winner) {
      winningAuthority = second;
      losingAuthority = first;
    }
    expect(worktreePaths(fixture.repository)).toHaveLength(2);
    const allocation = worktreeAllocation(fixture.repository);
    expect(await readFile(join(allocation.root, "tracked.txt"), "utf8")).toBe(
      "candidate\n",
    );
    await expect(
      losingAuthority.close(
        Object.freeze({ version: 1 as const, session: winner.session }),
      ),
    ).resolves.toEqual({ status: "rejected", code: "SESSION_MISMATCH" });
    expect(worktreePaths(fixture.repository)).toHaveLength(2);
    await expect(
      winningAuthority.revalidate(
        Object.freeze({ version: 1 as const, session: winner.session }),
      ),
    ).resolves.toMatchObject({ status: "valid" });
    await expect(
      winningAuthority.close(
        Object.freeze({ version: 1 as const, session: winner.session }),
      ),
    ).resolves.toMatchObject({ status: "closed" });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(await readdir(fixture.worktreeParent)).toEqual([]);
  });

  it("rejects target baseline drift and removes only its failed allocation", async () => {
    const fixture = await createFixture();
    runGit(fixture.repository, ["branch", "foreign"]);
    const invalid = prepareInput("baseline-drift");
    const result = await createAuthority(fixture).prepare(
      Object.freeze({
        ...invalid,
        changes: Object.freeze([
          Object.freeze({
            ...invalid.changes[0],
            baselineDigest: `sha256:${"f".repeat(64)}`,
          }),
        ]),
      }),
    );
    expect(result).toEqual({ status: "rejected", code: "BASELINE_MISMATCH" });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(
      gitExit(fixture.repository, [
        "show-ref",
        "--verify",
        "refs/heads/foreign",
      ]),
    ).toBe(0);
    expect(
      gitOutput(fixture.repository, ["branch", "--format=%(refname:short)"]),
    ).toContain("foreign\n");
  });

  it("refuses dirty removal and foreign sessions", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const firstAuthority = createAuthority(first);
    const secondAuthority = createAuthority(second);
    const prepared = await firstAuthority.prepare(prepareInput("dirty-close"));
    if (prepared.status !== "prepared")
      throw new Error("fixture allocation failed");
    const allocation = worktreeAllocation(first.repository);
    await writeFile(join(allocation.root, "tracked.txt"), "modified\n");
    expect(
      await firstAuthority.close(
        Object.freeze({ version: 1 as const, session: prepared.session }),
      ),
    ).toEqual({ status: "rejected", code: "DIRTY_WORKTREE" });
    expect(
      await secondAuthority.close(
        Object.freeze({ version: 1 as const, session: prepared.session }),
      ),
    ).toEqual({ status: "rejected", code: "SESSION_MISMATCH" });
    expect(worktreePaths(first.repository)).toContain(allocation.root);
  });

  it("rejects symlinked allocation parents and hostile input shapes", async () => {
    const fixture = await createFixture();
    const symlinkParent = join(fixture.root, "linked-worktrees");
    await symlink(fixture.worktreeParent, symlinkParent);
    const created = createTaskWorktree(
      Object.freeze({
        authorityId: "task-worktree-a",
        repositoryRoot: fixture.repository,
        worktreeParent: symlinkParent,
        repositoryId: "repo-a",
        rootIdentity: "root-a",
        ...policyConfig(),
      }),
    );
    if (created.status !== "created") throw new Error("authority setup failed");
    expect(await created.taskWorktree.prepare(prepareInput("symlink"))).toEqual(
      {
        status: "rejected",
        code: "SYMLINK_REJECTED",
      },
    );
    const validAuthority = createAuthority(fixture);
    expect(
      await validAuthority.prepare({ ...prepareInput("mutable") }),
    ).toEqual({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(
      await validAuthority.prepare(new Proxy(prepareInput("proxy"), {})),
    ).toEqual({
      status: "rejected",
      code: "INVALID_INPUT",
    });
  });
});
