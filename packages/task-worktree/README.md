# `@skizzles/task-worktree`

This package is the task-scoped Git worktree and change-control authority used
by Skizzles orchestration. Use it when an approved candidate must be validated
and committed in an isolated branch without granting broad Git or cleanup
authority to the caller.

## Public workflow

The package root exports `createTaskWorktree`, receipt guards, authority
contracts, sandbox and verification types, and deterministic Conventional
Commit planning types.

The facade derives an isolated branch and worktree from verified repository
state. It prepares only declared-path changes, returns deterministic split or
dependency-intervention results, runs host-declared validation profiles through
an enforcing sandbox broker, and revalidates candidate state before commit.
Sandbox requests bind timeout, output, drain, and signal-grace limits;
unsupported enforcement fails closed.

Authorization requires the latest successful ordered run and an opaque,
single-use promotion permit from the configured approval authority. The permit
binds repository and task identity, baseline, candidate, diff, sandbox
outcomes, executed profiles, revalidation, and the deterministic commit plan.
Copied permit objects and raw approval digests are rejected.

## Cleanup and dependencies

Cleanup removes only positively owned worktrees, branches, and sibling writable
roots. Partial cleanup returns an opaque retry handle with the original
terminal outcome. An ambiguous Git creation result grants no deletion
authority; retries stay pending until exact external resolution proves the
uncertain allocation absent.

The package consumes canonical candidate manifests from
[`@skizzles/candidate-manifest`](../candidate-manifest/README.md) and supervised
Git execution from
[`@skizzles/command-observation`](../command-observation/README.md).

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
