# Workspace policy

`@skizzles/workspace-policy` verifies the repository's Bun/TypeScript package
contract. It checks package ownership, public entrypoints, dependency closure,
relative-import containment, package-local documentation and tests, the single
root lockfile, and removal of superseded source layouts. Declared TypeScript
exports and binaries are compiled in memory as package-entrypoint smoke tests.
TypeScript exports are then imported in isolated Bun processes with stdin held
open. One deadline covers the importer exit and concurrent stdout/stderr EOF,
and the first output byte, a nonzero exit, a stream failure, or a lifecycle
timeout fails validation without accumulating output. On POSIX, each importer
leads a detached process group: failures kill the group and verify its removal,
and a clean importer exit is followed by a group probe so silent descendants
with ignored stdio are also rejected. Cleanup failures remain validation
failures.

This lifecycle gate assumes trusted package code; it is not a malicious-code
sandbox. A descendant that deliberately creates a new session or otherwise
re-detaches can escape POSIX process-group containment. Windows has no
negative-PGID detection here, so the gate kills and reaps the direct importer
for observable lifecycle failures but cannot make the POSIX descendant checks.

The package exports `validateWorkspace` for tests and exposes the
`skizzles-workspace-policy` executable. It does not modify the workspace.
