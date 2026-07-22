# `@skizzles/workspace-publication`

This package owns fail-closed publication of an approved set of workspace file
changes. Orchestration uses it after approval and isolated-worktree validation,
when the exact candidate bytes are ready to replace their canonical
destinations.

## Transaction boundary

The package root exports `createWorkspaceTransaction`,
`createLocalRepositoryLeaseAuthority`, their authority contracts, and public
result types. Publication and recovery are methods on the created transaction.

Candidates are published from destination-owned sibling files while a
repository-scoped exclusive lease is held. Every target is checked twice
against its approved identity and content before the journal enters
`publishing`. Once that state begins, recovery rolls the complete target set
forward. Before it begins, recovery leaves the old target set in place.

This is a recoverable multi-file transaction protocol. It does not claim that
a portable operating system provides one atomic rename across multiple files.
Each replacement relies on an authority-provided same-filesystem atomic rename;
the injected destination authority owns filesystem syscalls and must honor the
compare-and-rename contracts.

## Safety limits

All public inputs are untrusted. Paths are normalized to contained
POSIX-relative targets, journals are canonical and digest-protected, approvals
come from a trusted authority, and malformed or rebound state stops
publication. Cleanup touches only siblings carrying the transaction's ownership
tag; foreign artifacts are preserved and reported.

Tests use an isolated destination-authority fixture and never mutate a live
Codex home or workspace. The package has no runtime package dependencies.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
