# `@skizzles/workspace-publication`

Owns fail-closed publication of an approved set of workspace file changes.

The package publishes candidates from destination-owned sibling files while a
repository-scoped exclusive lease is held. Every target is checked against its
approved identity and content twice before the journal enters `publishing`.
Once publication begins, recovery deterministically rolls the complete target
set forward; before that boundary, recovery leaves the old target set in place.

This is a recoverable multi-file transaction protocol, not a claim that a
portable operating system provides one atomic rename for multiple files. Each
individual replacement uses an authority-provided same-filesystem atomic
rename. The injected destination authority owns filesystem syscalls and must
honor the compare-and-rename contracts. Tests use an isolated authority fixture
and never mutate a live Codex home or workspace.

Public inputs are untrusted. Paths are normalized to contained POSIX-relative
targets, journals are canonical and digest protected, approvals are consumed
through a trusted authority, and malformed or rebound state stops publication.
Cleanup touches only siblings carrying the transaction's ownership tag;
foreign artifacts are preserved and reported.
