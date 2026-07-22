import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  commitMessageHookEntrypoint,
  temporaryCommitMessageHookPath,
} from "../commit/hook.ts";
import type {
  TaskWorktreeAuthorizationResult,
  TaskWorktreeCommitResult,
  TaskWorktreeFailureCode,
  TaskWorktreeRevalidationResult,
  TaskWorktreeRunResult,
} from "../contract.ts";
import type { TaskWorktreeDigest } from "../digest.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import {
  consumePromotionPermit,
  createApprovalBinding,
  issuePromotionPermit,
} from "./approval.ts";
import { currentCandidateInput } from "./candidate.ts";
import { createLifecycleReceipt } from "./receipt.ts";
import {
  inspectAllocation,
  type TaskWorktreeSessionBindings,
  taskWorktreeSessionBindings,
} from "./state.ts";

export async function revalidateSession(
  owner: object,
  raw: unknown,
): Promise<TaskWorktreeRevalidationResult> {
  const parsed = parseSessionInput(raw, []);
  const bindings =
    parsed === undefined ? undefined : ownedBindings(owner, parsed.session);
  if (bindings === undefined) return rejected("SESSION_MISMATCH");
  const digest = await validate(bindings);
  return digest === undefined
    ? rejected("CANDIDATE_REJECTED")
    : Object.freeze({
        status: "valid",
        receipt: createLifecycleReceipt(
          owner,
          digest,
          "revalidate",
          bindings.summary,
        ),
      });
}

export async function runSession(
  owner: object,
  raw: unknown,
): Promise<TaskWorktreeRunResult> {
  const parsed = parseSessionInput(raw, ["profileIds"]);
  const bindings =
    parsed === undefined ? undefined : ownedBindings(owner, parsed.session);
  const profileIds =
    parsed === undefined
      ? undefined
      : parseIds(parsed.values.get("profileIds"));
  if (bindings === undefined || profileIds === undefined)
    return rejected("INVALID_INPUT");
  if ((await validate(bindings)) === undefined)
    return rejected("CANDIDATE_REJECTED");
  const invocationDigests: string[] = [];
  for (const id of profileIds) {
    const profile = bindings.commandProfiles.find(
      (candidate) => candidate.id === id,
    );
    if (profile === undefined) return rejected("COMMAND_FAILED");
    const cwd =
      profile.cwd === "." ? bindings.root : join(bindings.root, profile.cwd);
    const fromRoot = relative(bindings.root, cwd);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`))
      return rejected("COMMAND_FAILED");
    const execution = await bindings.sandbox.execute(
      Object.freeze({
        attestation: bindings.candidate.sandboxReceipt,
        command: Object.freeze({
          profile: profile.profile,
          executable: profile.executable,
          arguments: profile.arguments,
          cwd: profile.cwd,
        }),
        timeoutMilliseconds: profile.timeoutMilliseconds,
        maximumOutputBytes: profile.maximumOutputBytes,
        drainMilliseconds: profile.drainMilliseconds,
        signalGraceMilliseconds: profile.signalGraceMilliseconds,
        worktreeRoot: bindings.root,
        writeRoot: bindings.writableRoot,
      }),
    );
    if (execution.status !== "executed" || execution.receipt.exitCode !== 0) {
      return rejected("COMMAND_FAILED");
    }
    invocationDigests.push(execution.receipt.outcomeDigest);
    if ((await validate(bindings)) === undefined)
      return rejected("CANDIDATE_REJECTED");
  }
  const digest = digestTaskWorktreeValue({
    prepare: bindings.prepareDigest,
    profiles: profileIds,
    invocations: invocationDigests,
  });
  const receipt = createLifecycleReceipt(
    owner,
    digest,
    "run",
    bindings.summary,
  );
  bindings.latestRun = Object.freeze({
    digest,
    profileIds: Object.freeze([...profileIds]),
    outcomeDigests: Object.freeze([...invocationDigests]),
    receiptDigest: receipt.receiptDigest,
  });
  return Object.freeze({
    status: "ran",
    receipt,
  });
}

export async function commitSession(
  owner: object,
  raw: unknown,
): Promise<TaskWorktreeCommitResult> {
  const parsed = parseSessionInput(raw, ["permit"]);
  const bindings =
    parsed === undefined ? undefined : ownedBindings(owner, parsed.session);
  const permit = parsed?.values.get("permit");
  if (bindings === undefined) return rejected("INVALID_INPUT");
  if (bindings.candidate.committedHead !== null)
    return rejected("COMMIT_REJECTED");
  const revalidationDigest = await validate(bindings);
  if (revalidationDigest === undefined) return rejected("CANDIDATE_REJECTED");
  const approvalBinding = createApprovalBinding(bindings, revalidationDigest);
  if (approvalBinding === undefined) return rejected("APPROVAL_REJECTED");
  const approvalDigest = consumePromotionPermit(
    owner,
    bindings.session,
    permit,
    approvalBinding.bindingDigest,
  );
  if (approvalDigest === undefined) return rejected("APPROVAL_REJECTED");
  const authorization = bindings.commitAuthority.authorize(
    Object.freeze({
      receipt: bindings.candidate.commitReceipt,
      approvalDigest,
    }),
  );
  if (authorization.status !== "authorized") return rejected("COMMIT_REJECTED");
  const paths = bindings.input.changes.map(({ path }) => path);
  if (
    (await bindings.git.run(bindings.root, [
      "add",
      "--all",
      "--",
      ...paths,
    ])) === undefined
  )
    return rejected("COMMIT_REJECTED");
  const tree = await output(bindings, ["write-tree"]);
  const parent = await output(bindings, ["rev-parse", "HEAD"]);
  if (tree === undefined || parent === undefined)
    return rejected("COMMIT_REJECTED");
  const message = bindings.candidate.commitReceipt.plan.message.text;
  const hooksDirectory = join(bindings.writableRoot, "hooks");
  const hookPath = temporaryCommitMessageHookPath(hooksDirectory);
  const bun = Bun.which("bun");
  if (hookPath === undefined || bun === null)
    return rejected("COMMIT_REJECTED");
  try {
    await mkdir(hooksDirectory, { mode: 0o700 });
    await writeFile(
      hookPath,
      `#!/bin/sh\nexec '${shellQuote(bun)}' '${shellQuote(commitMessageHookEntrypoint)}' "$1"\n`,
      { mode: 0o700 },
    );
    await chmod(hookPath, 0o700);
  } catch {
    return rejected("COMMIT_REJECTED");
  }
  if (
    (await bindings.git.run(bindings.root, [
      "-c",
      `core.hooksPath=${hooksDirectory}`,
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
    ])) === undefined
  )
    return rejected("COMMIT_REJECTED");
  const head = await output(bindings, ["rev-parse", "HEAD"]);
  const committedParent = await output(bindings, ["rev-parse", "HEAD^"]);
  const committedTree = await output(bindings, ["rev-parse", "HEAD^{tree}"]);
  const committedMessage = await commitMessage(bindings);
  if (
    head === undefined ||
    committedParent !== parent ||
    committedTree !== tree ||
    committedMessage !== message
  )
    return rejected("COMMIT_REJECTED");
  bindings.candidate.committedHead = head;
  if ((await validate(bindings)) === undefined)
    return rejected("COMMIT_REJECTED");
  const digest = digestTaskWorktreeValue({
    authorization: authorization.approval.authorizationDigest,
    head,
    parent,
    tree,
    message: bindings.candidate.commitReceipt.plan.message.messageDigest,
  });
  return Object.freeze({
    status: "committed",
    receipt: createLifecycleReceipt(owner, digest, "commit", bindings.summary),
  });
}

export async function authorizeSession(
  owner: object,
  raw: unknown,
): Promise<TaskWorktreeAuthorizationResult> {
  const parsed = parseSessionInput(raw, ["approvalEvidence"]);
  if (parsed === undefined) return rejected("INVALID_INPUT");
  const bindings = ownedBindings(owner, parsed.session);
  if (bindings === undefined) return rejected("INVALID_INPUT");
  if (bindings.candidate.committedHead !== null)
    return rejected("COMMIT_REJECTED");
  const revalidationDigest = await validate(bindings);
  if (revalidationDigest === undefined) return rejected("CANDIDATE_REJECTED");
  const approvalBinding = createApprovalBinding(bindings, revalidationDigest);
  if (approvalBinding === undefined) return rejected("APPROVAL_REJECTED");
  const permit = await issuePromotionPermit(
    owner,
    bindings.session,
    bindings,
    approvalBinding,
    parsed.values.get("approvalEvidence"),
  );
  return permit === undefined
    ? rejected("APPROVAL_REJECTED")
    : Object.freeze({ status: "authorized", permit });
}

function shellQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}

async function commitMessage(
  bindings: TaskWorktreeSessionBindings,
): Promise<string | undefined> {
  const result = await bindings.git.run(bindings.root, [
    "log",
    "-1",
    "--format=%B",
  ]);
  if (result === undefined) return;
  const value = result.stdout.replace(/\n+$/u, "");
  return value.length > 0 ? value : undefined;
}

async function validate(
  bindings: TaskWorktreeSessionBindings,
): Promise<TaskWorktreeDigest | undefined> {
  const allocation = await inspectAllocation(bindings);
  if (allocation === undefined || !allocation.registered) return;
  const current = await currentCandidateInput(
    bindings.root,
    bindings.input,
    bindings.candidate.diffInput.baseline,
  );
  if (
    current === undefined ||
    !bindings.diffAuthority.verify(
      Object.freeze({
        input: current,
        receipt: bindings.candidate.diffReceipt,
      }),
    )
  )
    return;
  const status = await bindings.git.run(bindings.root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status === undefined) return;
  const allowed = new Set(bindings.input.changes.map(({ path }) => path));
  for (const entry of status.stdout
    .split("\0")
    .filter((value) => value.length > 0)) {
    const path = entry.slice(3);
    if (!allowed.has(path)) return;
  }
  if (
    bindings.candidate.committedHead !== null &&
    (status.stdout.length !== 0 ||
      allocation.head !== bindings.candidate.committedHead)
  )
    return;
  return digestTaskWorktreeValue({
    prepare: bindings.prepareDigest,
    candidate: bindings.candidate.candidateDigest,
    head: allocation.head,
    status: status.stdout,
  });
}

async function output(
  bindings: TaskWorktreeSessionBindings,
  arguments_: readonly string[],
): Promise<string | undefined> {
  const result = await bindings.git.run(bindings.root, arguments_);
  if (result === undefined) return;
  const value = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1)
    : result.stdout;
  return value.length > 0 && !value.includes("\n") ? value : undefined;
}

function ownedBindings(
  owner: object,
  session: unknown,
): TaskWorktreeSessionBindings | undefined {
  const bindings = taskWorktreeSessionBindings(session);
  return bindings !== undefined && bindings.owner === owner && !bindings.closed
    ? bindings
    : undefined;
}

function parseSessionInput(
  raw: unknown,
  extras: readonly string[],
):
  | Readonly<{ session: unknown; values: ReadonlyMap<string, unknown> }>
  | undefined {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !Object.isFrozen(raw)
  )
    return;
  const keys = ["session", "version", ...extras];
  if (Reflect.ownKeys(raw).length !== keys.length) return;
  const values = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !("value" in descriptor)) return;
    values.set(key, descriptor.value);
  }
  return values.get("version") === 1
    ? Object.freeze({ session: values.get("session"), values })
    : undefined;
}

function parseIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !Object.isFrozen(value) || value.length > 64)
    return;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || ids.includes(id)) return;
    ids.push(id);
  }
  return Object.freeze(ids);
}

function rejected(
  code: TaskWorktreeFailureCode,
): Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }> {
  return Object.freeze({ status: "rejected", code });
}
