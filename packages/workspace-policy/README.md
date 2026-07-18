# Workspace policy

`@skizzles/workspace-policy` verifies the repository's Bun/TypeScript package
contract. It checks package ownership, public entrypoints, dependency closure,
relative-import containment, package-local documentation and tests, the single
root lockfile, and removal of superseded source layouts. Declared TypeScript
exports and binaries are compiled in memory as package-entrypoint smoke tests.
TypeScript exports are then imported in isolated Bun processes with stdin held
open; a nonzero exit, output, or import that waits on stdin fails validation.

The package exports `validateWorkspace` for tests and exposes the
`skizzles-workspace-policy` executable. It does not modify the workspace.
