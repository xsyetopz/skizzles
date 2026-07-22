import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createTaskWorktree,
  digestTaskWorktreeBytes,
  type TaskWorktreeApprovalAuthorityRequest,
} from "../../src/index.ts";

const git = Bun.which("git");
const fixtures: string[] = [];
const approvalEvidence = new WeakSet<object>();

export function createApprovalEvidence(): Readonly<{ kind: "approved" }> {
  const evidence = Object.freeze({ kind: "approved" as const });
  approvalEvidence.add(evidence);
  return evidence;
}

export async function cleanupFixtures(): Promise<void> {
  await Promise.all(
    fixtures
      .splice(0)
      .map(
        async (fixture) => await rm(fixture, { force: true, recursive: true }),
      ),
  );
}

export interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly worktreeParent: string;
}

export async function createFixture(): Promise<Fixture> {
  if (git === null) throw new Error("Git is required for lifecycle tests");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "skizzles-task-worktree-")),
  );
  fixtures.push(root);
  const repository = join(root, "repository");
  const worktreeParent = join(root, "worktrees");
  await Bun.write(join(root, ".keep"), "");
  await Bun.$`mkdir -p ${repository} ${worktreeParent}`.quiet();
  runGit(repository, ["init", "-b", "main"]);
  runGit(repository, ["config", "user.name", "Skizzles Test"]);
  runGit(repository, ["config", "user.email", "test@skizzles.invalid"]);
  await mkdir(join(repository, "spec"));
  await writeFile(join(repository, "spec/rules.md"), "normative\n");
  await writeFile(join(repository, "tracked.txt"), "baseline\n");
  runGit(repository, ["add", "spec", "tracked.txt"]);
  runGit(repository, ["commit", "-m", "chore: baseline"]);
  return Object.freeze({ root, repository, worktreeParent });
}

export function createAuthority(fixture: Fixture) {
  return createAuthorityWithApproval(fixture, policyConfig().approvalAuthority);
}

export function createAuthorityWithApproval(
  fixture: Fixture,
  approvalAuthority: Readonly<{
    id: string;
    authorize: (request: TaskWorktreeApprovalAuthorityRequest) => unknown;
  }>,
) {
  const base = policyConfig();
  const created = createTaskWorktree(
    Object.freeze({
      authorityId: "task-worktree-a",
      repositoryRoot: fixture.repository,
      worktreeParent: fixture.worktreeParent,
      repositoryId: "repo-a",
      rootIdentity: "root-a",
      ...base,
      approvalAuthority,
    }),
  );
  if (created.status !== "created") throw new Error("authority setup failed");
  return created.taskWorktree;
}

export function prepareInput(taskId: string) {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const baselineDigest = digestTaskWorktreeBytes(
    new TextEncoder().encode("baseline\n"),
  );
  return Object.freeze({
    taskId,
    taskEpochDigest: digest,
    requestDigest: digest,
    repositoryId: "repo-a",
    rootIdentity: "root-a",
    treeDigest: digest,
    baselineDigest: digest,
    changes: Object.freeze([
      Object.freeze({
        path: "tracked.txt",
        operation: "write" as const,
        baselineDigest,
        candidateBytes: Object.freeze([
          99, 97, 110, 100, 105, 100, 97, 116, 101, 10,
        ]),
      }),
    ]),
  });
}

export function policyConfig() {
  return {
    protectedPaths: Object.freeze({
      policyId: "protected-a",
      testRoots: Object.freeze([]),
      specificationRoots: Object.freeze(["spec"]),
      authorize: async (request: {
        readonly requestDigestOfThisMaterial: string;
      }) =>
        Object.freeze({
          status: "authorized" as const,
          requestDigest: request.requestDigestOfThisMaterial,
          mode: "implementation" as const,
          authorizedTestPaths: Object.freeze([]),
          authorizationDigest: `sha256:${"c".repeat(64)}` as const,
        }),
    }),
    approvalAuthority: Object.freeze({
      id: "approval-a",
      authorize: async (request: TaskWorktreeApprovalAuthorityRequest) => {
        if (
          typeof request.approvalEvidence !== "object" ||
          request.approvalEvidence === null ||
          !approvalEvidence.has(request.approvalEvidence)
        ) {
          return Object.freeze({ status: "rejected" });
        }
        return Object.freeze({
          status: "approved" as const,
          bindingDigest: request.binding.bindingDigest,
          approvalDigest: `sha256:${"b".repeat(64)}` as const,
        });
      },
    }),
    diffCeilings: Object.freeze({
      maxChangedFiles: 8,
      maxAddedLines: 100,
      maxDeletedLines: 100,
      maxChangedBytes: 10_000,
    }),
    commitPolicy: Object.freeze({
      maxSubjectLength: 72,
      ownedPackagePaths: Object.freeze([
        Object.freeze({ path: "tracked.txt", scope: "fixture" }),
      ]),
    }),
    sandbox: Object.freeze({
      id: "sandbox-a",
      attest: async (paths: readonly string[]) =>
        Object.freeze({
          mechanism: "seatbelt" as const,
          writePaths: paths,
          deniesUndeclaredWrites: true as const,
          deniesSystemControl: true as const,
          readOnlyWorktree: true as const,
          networkDisabled: true as const,
          boundedProcessTree: true as const,
          evidence: "fixture-attestation",
        }),
      execute: async (request: { readonly bindingDigest: string }) =>
        Object.freeze({
          exitCode: 0,
          stdoutDigest: "0".repeat(64),
          stderrDigest: "0".repeat(64),
          stdoutBytes: 0,
          stderrBytes: 0,
          bindingDigest: request.bindingDigest,
        }),
    }),
    sandboxWritePaths: Object.freeze([".skizzles-cache"]),
    dependencyResolver: Object.freeze({
      id: "resolver-a",
      resolve: async () =>
        Object.freeze({
          ecosystem: "npm" as const,
          name: "unused",
          requestedRange: "1",
          resolvedVersion: "1.0.0",
          registry: "fixture",
        }),
    }),
    dependencyRequests: Object.freeze([]),
    commandProfiles: Object.freeze([
      Object.freeze({
        id: "status",
        profile: "read-only" as const,
        executable: "git" as const,
        arguments: Object.freeze(["status"]),
        cwd: ".",
        timeoutMilliseconds: 10_000,
        maximumOutputBytes: 1024 * 1024,
        drainMilliseconds: 1000,
        signalGraceMilliseconds: 1000,
      }),
    ]),
    verificationProfiles: Object.freeze([]),
  };
}

export function worktreeAllocation(repository: string): {
  readonly branch: string;
  readonly root: string;
} {
  const fields = gitOutput(repository, ["worktree", "list", "--porcelain"])
    .trim()
    .split("\n\n")
    .map((block) => block.split("\n"));
  const block = fields.find((entry) =>
    entry.some((line) => line.startsWith("branch refs/heads/codex/task-")),
  );
  const root = block
    ?.find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length);
  const branch = block
    ?.find((line) => line.startsWith("branch refs/heads/"))
    ?.slice("branch refs/heads/".length);
  if (root === undefined || branch === undefined)
    throw new Error("missing worktree allocation");
  return Object.freeze({ branch, root });
}

export function worktreePaths(repository: string): readonly string[] {
  return gitOutput(repository, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

export function runGit(cwd: string, arguments_: readonly string[]): void {
  const result = Bun.spawnSync([git ?? "git", ...arguments_], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

export function gitOutput(cwd: string, arguments_: readonly string[]): string {
  const result = Bun.spawnSync([git ?? "git", ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

export function gitExit(cwd: string, arguments_: readonly string[]): number {
  return Bun.spawnSync([git ?? "git", ...arguments_], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode;
}
