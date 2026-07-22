// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { createTaskWorktree } from "../../src/index.ts";
import {
  cleanupFixtures,
  createAuthority,
  createFixture,
  type Fixture,
  policyConfig,
  prepareInput,
  runGit,
  worktreeAllocation,
  worktreePaths,
} from "./support.ts";

afterEach(cleanupFixtures);

describe("failed preparation cleanup ownership", () => {
  it("retains an opaque retry handle when Git refuses worktree removal", async () => {
    const fixture = await createFixture();
    const authority = createFaultAuthority(fixture, () => {
      const allocation = worktreeAllocation(fixture.repository);
      runGit(fixture.repository, [
        "worktree",
        "lock",
        "--reason",
        "cleanup-test",
        allocation.root,
      ]);
    });
    const result = await authority.prepare(invalidBaseline("remove-failure"));
    if (result.status !== "cleanup-pending") {
      throw new Error(`expected cleanup-pending, received ${result.status}`);
    }
    expect(result.outcome).toEqual({
      status: "rejected",
      code: "BASELINE_MISMATCH",
    });
    expect(Object.keys(result.handle)).toEqual(["schema"]);
    expect(Object.isFrozen(result.handle)).toBe(true);
    expect(worktreePaths(fixture.repository)).toHaveLength(2);
    expect(
      await createAuthority(fixture).retryCleanup(
        Object.freeze({ version: 1 as const, handle: result.handle }),
      ),
    ).toEqual({ status: "rejected", code: "SESSION_MISMATCH" });
    const allocation = worktreeAllocation(fixture.repository);
    runGit(fixture.repository, ["worktree", "unlock", allocation.root]);
    const cleaned = await authority.retryCleanup(
      Object.freeze({ version: 1 as const, handle: result.handle }),
    );
    expect(cleaned).toEqual({
      status: "cleaned",
      outcome: { status: "rejected", code: "BASELINE_MISMATCH" },
    });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(await readdir(fixture.worktreeParent)).toEqual([]);
  });

  it("retries writable-root removal without reporting a false clean", async () => {
    const fixture = await createFixture();
    let writableRoot = "";
    const redirect = join(fixture.root, "redirect");
    await mkdir(redirect);
    const authority = createFaultAuthority(fixture, async () => {
      writableRoot = await allocationPath(fixture, "-writable");
      await rm(writableRoot, { recursive: true });
      await symlink(redirect, writableRoot);
    });
    const result = await authority.prepare(invalidBaseline("writable-failure"));
    if (result.status !== "cleanup-pending") {
      throw new Error(`expected cleanup-pending, received ${result.status}`);
    }
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(
      await authority.retryCleanup(cleanupInput(result.handle)),
    ).toMatchObject({ status: "cleanup-pending" });
    await rm(writableRoot);
    await mkdir(writableRoot, { mode: 0o700 });
    expect(await authority.retryCleanup(cleanupInput(result.handle))).toEqual({
      status: "cleaned",
      outcome: { status: "rejected", code: "BASELINE_MISMATCH" },
    });
    expect(await readdir(fixture.worktreeParent)).toEqual([]);
  });

  it("preserves the allocation until an inaccessible claim can be authenticated", async () => {
    const fixture = await createFixture();
    let claimRoot = "";
    const authority = createFaultAuthority(fixture, async () => {
      claimRoot = await allocationPath(fixture, "-claim");
      await chmod(claimRoot, 0o000);
    });
    const result = await authority.prepare(invalidBaseline("claim-failure"));
    if (result.status !== "cleanup-pending") {
      throw new Error(`expected cleanup-pending, received ${result.status}`);
    }
    expect(worktreePaths(fixture.repository)).toHaveLength(2);
    await chmod(claimRoot, 0o700);
    expect(await authority.retryCleanup(cleanupInput(result.handle))).toEqual({
      status: "cleaned",
      outcome: { status: "rejected", code: "BASELINE_MISMATCH" },
    });
    expect(worktreePaths(fixture.repository)).toEqual([fixture.repository]);
    expect(await readdir(fixture.worktreeParent)).toEqual([]);
  });

  it("preserves an ambiguous allocation until external resolution", async () => {
    const fixture = await createFixture();
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("Git is required");
    const bin = join(fixture.root, "bin");
    const wrapper = join(bin, "git");
    await mkdir(bin);
    await writeFile(wrapper, ambiguousGitWrapper(realGit));
    await chmod(wrapper, 0o755);
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "ambiguous-helper.ts"),
        fixture.root,
        fixture.repository,
        fixture.worktreeParent,
      ],
      {
        cwd: join(import.meta.dir, "../.."),
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.prepared).toBe("cleanup-pending");
    expect(result.outcome).toEqual({
      status: "rejected",
      code: "COMMAND_FAILED",
    });
    expect(result.pending).toMatchObject({
      status: "cleanup-pending",
      outcome: { status: "rejected", code: "COMMAND_FAILED" },
    });
    expect(result.retained).toHaveLength(2);
    expect(result.cleaned).toEqual({
      status: "cleaned",
      outcome: { status: "rejected", code: "COMMAND_FAILED" },
    });
    expect(result.paths).toEqual([fixture.repository]);
    expect(result.entries).toEqual([]);
  });
});

function ambiguousGitWrapper(realGit: string): string {
  return [
    "#!/bin/sh",
    `real_git='${realGit}'`,
    "is_add=0",
    "take_root=0",
    'previous=""',
    'root=""',
    'for argument in "$@"; do',
    '  if [ "$previous" = "worktree" ] && [ "$argument" = "add" ]; then is_add=1; fi',
    '  if [ "$take_root" = "1" ]; then root="$argument"; take_root=0; fi',
    '  if [ "$argument" = "--" ]; then take_root=1; fi',
    // biome-ignore lint/security/noSecrets: shell fixture assignment, not a credential
    '  previous="$argument"',
    "done",
    '"$real_git" "$@"',
    "status=$?",
    'if [ "$is_add" = "1" ] && [ "$status" = "0" ]; then',
    '  "$real_git" -C "$PWD" worktree lock --reason cleanup-test "$root" || exit 2',
    "  exit 1",
    "fi",
    "exit $status",
    "",
  ].join("\n");
}

function createFaultAuthority(
  fixture: Fixture,
  inject: () => void | Promise<void>,
) {
  const policy = policyConfig();
  const created = createTaskWorktree(
    Object.freeze({
      authorityId: "task-worktree-fault",
      repositoryRoot: fixture.repository,
      worktreeParent: fixture.worktreeParent,
      repositoryId: "repo-a",
      rootIdentity: "root-a",
      ...policy,
      sandbox: Object.freeze({
        ...policy.sandbox,
        attest: async (paths: readonly string[]) => {
          await inject();
          return Object.freeze({
            mechanism: "seatbelt" as const,
            writePaths: paths,
            deniesUndeclaredWrites: true as const,
            deniesSystemControl: true as const,
            readOnlyWorktree: true as const,
            networkDisabled: true as const,
            boundedProcessTree: true as const,
            evidence: "fault-attestation",
          });
        },
      }),
    }),
  );
  if (created.status !== "created") throw new Error("authority setup failed");
  return created.taskWorktree;
}

function invalidBaseline(taskId: string) {
  const input = prepareInput(taskId);
  return Object.freeze({
    ...input,
    changes: Object.freeze([
      Object.freeze({
        ...input.changes[0],
        baselineDigest: `sha256:${"f".repeat(64)}` as const,
      }),
    ]),
  });
}

function cleanupInput(handle: unknown) {
  return Object.freeze({ version: 1 as const, handle });
}

async function allocationPath(
  fixture: Fixture,
  suffix: string,
): Promise<string> {
  const name = (await readdir(fixture.worktreeParent)).find((entry) =>
    entry.endsWith(suffix),
  );
  if (name === undefined) throw new Error(`missing ${suffix} allocation`);
  return join(fixture.worktreeParent, name);
}
