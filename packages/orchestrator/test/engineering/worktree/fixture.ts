import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createTaskWorktree,
  type TaskWorktree,
  type TaskWorktreeApprovalAuthorityRequest,
} from "@skizzles/task-worktree";
import { TaskWorktreeApprovalBridge } from "../../../src/workflow/worktree/approval.ts";

const git = Bun.which("git");

export function createTestTaskWorktree(): Readonly<{
  taskWorktree: TaskWorktree;
  taskWorktreeApproval: TaskWorktreeApprovalBridge;
  cleanup: () => void;
}> {
  if (git === null) throw new Error("Git is required for workflow tests");
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "skizzles-engineering-worktree-")),
  );
  const repository = join(root, "repository");
  const worktreeParent = join(root, "worktrees");
  const taskWorktreeApproval = new TaskWorktreeApprovalBridge(
    "engineering-approval",
  );
  mkdirSync(repository);
  mkdirSync(worktreeParent);
  runGit(repository, ["init", "-b", "main"]);
  runGit(repository, ["config", "user.name", "Skizzles Test"]);
  runGit(repository, ["config", "user.email", "test@skizzles.invalid"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  runGit(repository, ["add", "README.md"]);
  runGit(repository, ["commit", "-m", "chore: baseline"]);
  const created = createTaskWorktree(
    Object.freeze({
      authorityId: "engineering-task-worktree",
      approvalAuthority: Object.freeze({
        id: "engineering-approval",
        authorize: (request: TaskWorktreeApprovalAuthorityRequest) =>
          taskWorktreeApproval.authorize(request),
      }),
      repositoryRoot: repository,
      worktreeParent,
      repositoryId: "repo-a",
      rootIdentity: "root-a",
      diffCeilings: Object.freeze({
        maxChangedFiles: 64,
        maxAddedLines: 10_000,
        maxDeletedLines: 10_000,
        maxChangedBytes: 2_000_000,
      }),
      commitPolicy: Object.freeze({
        maxSubjectLength: 72,
        ownedPackagePaths: Object.freeze([
          Object.freeze({ path: "src", scope: "fixture" }),
          Object.freeze({ path: "test", scope: "fixture" }),
        ]),
      }),
      sandbox: Object.freeze({
        id: "engineering-sandbox",
        attest: async (paths: readonly string[]) =>
          Object.freeze({
            mechanism: "seatbelt" as const,
            writePaths: paths,
            deniesUndeclaredWrites: true as const,
            deniesSystemControl: true as const,
            readOnlyWorktree: true as const,
            networkDisabled: true as const,
            boundedProcessTree: true as const,
            evidence: "engineering-fixture-attestation",
          }),
        execute: async (request: {
          readonly bindingDigest: string;
          readonly command: {
            readonly executable: "bun" | "git";
            readonly arguments: readonly string[];
            readonly cwd: string;
          };
          readonly worktreeRoot: string;
        }) => {
          const result = Bun.spawnSync(
            [request.command.executable, ...request.command.arguments],
            {
              cwd:
                request.command.cwd === "."
                  ? request.worktreeRoot
                  : join(request.worktreeRoot, request.command.cwd),
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const stdout = result.stdout.toString();
          const stderr = result.stderr.toString();
          return Object.freeze({
            exitCode: result.exitCode,
            stdoutDigest: digest(stdout),
            stderrDigest: digest(stderr),
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength(stderr),
            bindingDigest: request.bindingDigest,
          });
        },
      }),
      sandboxWritePaths: Object.freeze([".skizzles-cache"]),
      dependencyResolver: Object.freeze({
        id: "engineering-resolver",
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
      commandProfiles: Object.freeze(
        ["validate", "negative-test"].map((id) =>
          Object.freeze({
            id,
            profile: "read-only" as const,
            executable: "git" as const,
            arguments: Object.freeze(["status"]),
            cwd: ".",
            timeoutMilliseconds: 10_000,
            maximumOutputBytes: 1024 * 1024,
            drainMilliseconds: 1000,
            signalGraceMilliseconds: 1000,
          }),
        ),
      ),
    }),
  );
  if (created.status !== "created") {
    rmSync(root, { force: true, recursive: true });
    throw new Error("engineering task-worktree fixture rejected");
  }
  return Object.freeze({
    taskWorktree: created.taskWorktree,
    taskWorktreeApproval,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  });
}

function runGit(cwd: string, arguments_: readonly string[]): void {
  const result = Bun.spawnSync([git ?? "git", ...arguments_], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
