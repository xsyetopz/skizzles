import type { TaskWorktreeCommitAuthority } from "../commit/contract.ts";
import type {
  TaskWorktree,
  TaskWorktreePrepareInput,
  TaskWorktreeReceiptSummary,
  TaskWorktreeSession,
} from "../contract.ts";
import type { DependencyResolutionService } from "../dependency/resolution.ts";
import type { TaskWorktreeDiffAuthority } from "../diff/contract.ts";
import type { digestTaskWorktreeValue } from "../digest.ts";
import type { GitCommandAuthority } from "../git/command.ts";
import type { RepositorySnapshot } from "../git/repository.ts";
import { branchHead, isClean, listWorktrees } from "../git/repository.ts";
import type { PortableSandboxBroker } from "../sandbox/capabilities.ts";
import type { TaskWorktreeVerificationReceipt } from "../verification/contract.ts";
import type { PreparedCandidate } from "./candidate/contract.ts";
import type { parseConfig } from "./configuration/config.ts";

export interface TaskWorktreeSessionBindings {
  readonly owner: object;
  readonly session: TaskWorktreeSession;
  readonly git: GitCommandAuthority;
  readonly repository: RepositorySnapshot;
  readonly input: TaskWorktreePrepareInput;
  readonly branch: string;
  readonly root: string;
  readonly writableRoot: string;
  readonly prepareDigest: ReturnType<typeof digestTaskWorktreeValue>;
  readonly candidate: PreparedCandidate;
  readonly diffAuthority: TaskWorktreeDiffAuthority;
  readonly commitAuthority: TaskWorktreeCommitAuthority;
  readonly commandProfiles: AuthorityState["config"]["commandProfiles"];
  readonly verificationProfiles: AuthorityState["config"]["verificationProfiles"];
  readonly protectedPaths: AuthorityState["config"]["protectedPaths"];
  readonly sandbox: PortableSandboxBroker;
  readonly sandboxWritePaths: readonly string[];
  readonly approvalAuthority: AuthorityState["config"]["approvalAuthority"];
  readonly summary: TaskWorktreeReceiptSummary;
  latestRun: Readonly<{
    digest: ReturnType<typeof digestTaskWorktreeValue>;
    profileIds: readonly string[];
    outcomeDigests: readonly string[];
    receiptDigest: ReturnType<typeof digestTaskWorktreeValue>;
  }> | null;
  readonly verification: {
    baselineViewRoot: string | null;
    readonly receipts: TaskWorktreeVerificationReceipt[];
  };
  readonly cleanup: {
    worktreeRemoved: boolean;
    writableRemoved: boolean;
    baselineViewRemoved: boolean;
    branchRemoved: boolean;
    finalHead: string | null;
  };
  closed: boolean;
}

export interface AuthorityState {
  readonly owner: object;
  readonly git: GitCommandAuthority;
  readonly config: NonNullable<ReturnType<typeof parseConfig>>;
  readonly active: Map<string, TaskWorktreeSession>;
  readonly used: Set<string>;
  readonly diffAuthority: TaskWorktreeDiffAuthority;
  readonly commitAuthority: TaskWorktreeCommitAuthority;
  readonly sandbox: PortableSandboxBroker;
  readonly dependencies: DependencyResolutionService;
}

const authorities = new WeakMap<object, AuthorityState>();
const ownerStates = new WeakMap<object, AuthorityState>();
const sessions = new WeakMap<object, TaskWorktreeSessionBindings>();

export function registerAuthority(
  taskWorktree: TaskWorktree,
  state: AuthorityState,
): void {
  authorities.set(taskWorktree, state);
  ownerStates.set(state.owner, state);
}

export function isRegisteredTaskWorktree(
  input: unknown,
): input is TaskWorktree {
  return typeof input === "object" && input !== null && authorities.has(input);
}

export function stateForOwner(owner: object): AuthorityState | undefined {
  return ownerStates.get(owner);
}

export function taskWorktreeSessionBindings(
  input: unknown,
): TaskWorktreeSessionBindings | undefined {
  return typeof input === "object" && input !== null
    ? sessions.get(input)
    : undefined;
}

export function bindSession(
  session: TaskWorktreeSession,
  bindings: TaskWorktreeSessionBindings,
): void {
  sessions.set(session, bindings);
}

export function taskKeyFor(input: TaskWorktreePrepareInput): string {
  return `${input.repositoryId}\0${input.rootIdentity}\0${input.taskId}\0${input.taskEpochDigest}`;
}

export async function inspectAllocation(
  bindings: TaskWorktreeSessionBindings,
): Promise<
  Readonly<{ clean: boolean; head: string; registered: boolean }> | undefined
> {
  if (bindings.closed) {
    return;
  }
  const entries = await listWorktrees(bindings.git, bindings.repository.root);
  const clean = await isClean(bindings.git, bindings.root);
  const head = await branchHead(
    bindings.git,
    bindings.repository.root,
    bindings.branch,
  );
  if (
    entries === undefined ||
    clean === undefined ||
    head === undefined ||
    head === null
  ) {
    return;
  }
  const matching = entries.filter((entry) => entry.root === bindings.root);
  return Object.freeze({
    clean,
    head,
    registered:
      matching.length === 1 &&
      matching[0]?.branch === bindings.branch &&
      matching[0]?.head === head,
  });
}
