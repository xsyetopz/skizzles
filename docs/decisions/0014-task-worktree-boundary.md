# ADR 0014: Task-scoped Git worktree boundary

- Status: Accepted
- Date: 2026-07-22

## Context

The orchestration workflow previously copied a repository subtree into a
disposable command directory before validation. That isolated candidate bytes
from the canonical destination, but it did not provide Git branch identity,
parallel-worker isolation, OS sandbox enforcement, deterministic diff ceilings,
or an approved commit contract. Phase 5 requires those properties without
granting an agent arbitrary Git, shell, filesystem, container, or hook authority.

Literal commits after every file write would fragment one reviewable change
into polluted history and allow partially validated states to acquire durable
identity. Platform-specific Landlock, AppArmor, container namespace, or Seatbelt
claims are also invalid unless the configured host can enforce and attest them.

## Decision

Create `@skizzles/task-worktree` as the sole task-scoped Git execution owner.
The package authenticates one facade and opaque sessions, derives stable task
branches, creates isolated worktrees, and admits candidate writes only through
an exact declared relative-path gateway. It rejects traversal, aliases, `.git`,
symlink and hardlink redirection, baseline drift, forged authorities, and
undeclared mutations.

The host owns file, line, and byte ceilings. Exact baseline and candidate bytes
produce an authenticated diff receipt; oversized multi-file work returns a
complete deterministic split plan, while an unsplittable file rejects. Package
resolution mismatches return structured intervention evidence and never trigger
installation, teardown, or environment reconstruction.

Validation commands are host-declared read, build, check, or test profiles.
They run only through an authentic sandbox authority bound to a read-only
worktree, network denial, bounded process tree, and a disjoint task-owned
writable root. Missing enforcement fails closed. No generic shell or destructive
Git, filesystem, package-manager, container-admin, or system-control capability
is public.

After the latest successful sandbox run, an authentic approval bridge binds the
ordered profiles and outcome digests, exact task receipt, transaction, diff, and
single-use promotion permit. The package then synthesizes one deterministic
Conventional Commit from the exact task slice, validates it through an
invocation-scoped `commit-msg` hook, commits the isolated branch once, and
revalidates parent, tree, message, and candidate state. The orchestrator then
delegates canonical publication to `@skizzles/workspace-transaction`. Rejection
removes the exact positively owned uncommitted worktree; uncertain creation
grants no removal authority and retains an opaque cleanup handle until external
resolution proves absence. Uncertain publication preserves the session for
recovery; cleanup is retryable and never removes a foreign worktree or branch.

The prior orchestrator copy-staging command implementation is deleted. There is
no fallback or compatibility route.

## Rejected alternatives

- Keep copy staging beside worktrees: two isolation authorities would drift and
  make approval evidence ambiguous.
- Auto-commit after each file edit: this creates partial commits before batch
  validation and destroys atomic review.
- Accept sandbox attestations but execute commands directly: evidence without
  enforced execution is a false security boundary.
- Install repository-wide hooks: canonical `.git/hooks` is shared mutable host
  state outside task ownership.
- Automatically repair dependency mismatches: teardown or reconstruction can
  destroy developer state and hides supply-chain uncertainty.

## Consequences

- Parallel tasks modifying the same path cannot overwrite each other's worktree.
- Approval binds exact candidate, diff, sandbox, dependency, command-profile,
  and commit-message evidence.
- Hosts must provide a real supported sandbox executor; unsupported hosts reject
  validation rather than silently weakening isolation.
- A task slice creates one isolated commit, not one commit per file.
- Worktree and writable-root cleanup becomes part of workflow recovery truth.

## Confirmation

- `packages/task-worktree/test/` uses real temporary Git repositories for
  branch collision, parallel isolation, commit-hook, drift, and cleanup proof.
- Candidate security tests cover traversal, aliases, symlinks, hardlinks,
  no-follow writes, exact byte binding, split plans, and intervention evidence.
- Sandbox tests reject attest-only, forged, drifted, nested-root, and unavailable
  authorities.
- Orchestrator causal tests bind the worktree receipt into approval, commit only
  after a valid permit, preserve uncertainty for recovery, and close rejected
  sessions.
- `bun run workspace:check`, package gates, aggregate verification, architectural
  audit, and plugin parity remain release requirements.

## Review triggers

- A supported platform changes its sandbox enforcement primitive.
- Git worktree or hook invocation semantics change.
- Parallel scheduling introduces cross-repository task graphs.
- Canonical publication moves away from `@skizzles/workspace-transaction`.
