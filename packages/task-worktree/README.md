# `@skizzles/task-worktree`

Authentic, task-scoped Git worktree lifecycle and change-control authority for
Skizzles orchestration. The package derives an isolated branch and worktree from
verified repository state, supervises every Git subprocess, and exposes only
opaque sessions and immutable digest receipts.

The facade prepares exact declared-path changes, returns deterministic split or
dependency-intervention results, runs host-declared validation profiles only
through an enforcing sandbox broker, and revalidates candidate state before any
commit. Sandbox requests bind timeout, output, drain, and signal-grace limits;
unsupported enforcement fails closed.

Authorization requires the latest successful ordered run and an opaque,
single-use promotion permit from the configured approval authority. The permit
binds repository and task identity, baseline, candidate, diff, sandbox outcomes,
executed profiles, revalidation, and the deterministic Conventional Commit
plan. Raw approval digests and copied permit objects are not accepted.

Cleanup removes only positively owned worktrees, branches, and sibling writable
roots. Partial cleanup returns an opaque retry handle with the original terminal
outcome. An ambiguous Git creation result grants no deletion authority: retries
remain pending until exact external resolution proves the uncertain allocation
absent.
