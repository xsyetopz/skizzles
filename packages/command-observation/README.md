# `@skizzles/command-observation`

This private package supervises durable command execution and retained-output
queries. Skizzles hooks use it when a command may outgrow the calling context;
library callers can use its direct-argv observation API without invoking a
shell.

## Programmatic entrypoint

`@skizzles/command-observation` exports the import-safe `dispatchCommand` CLI
facade, the direct-argv `observeCommand` API, `recoverCommandOutput`, receipt
guards, and the public specification and result types. Importing the package
does not dispatch an executable.

`observeCommand` accepts a strict versioned specification containing an
absolute executable path, argument vector, working directory, complete
environment, timeout, per-stream byte cap, drain bound, signal-grace bound, and
optional abort signal. It never accepts a shell command string.

The immutable receipt binds the invocation to one terminal outcome. Exit,
signal, timeout, abort, invalid-spec, spawn-failure, output-limit, stream-drain,
and process-tree cleanup states remain distinct. A malformed or hostile
specification returns a no-spawn `invalid-spec` receipt with the fixed redacted
`INVALID_SPEC` code; it does not throw. Standard error alone does not turn a
successful exit into failure. `recoverCommandOutput` returns a copy of bounded
output bytes from an authentic receipt.

## Supervisor CLI

The source workspace runs the canonical CLI with:

```sh
bun run packages/command-observation/src/codex-command.ts --help
```

Generated plugins expose `runtime/codex-command.ts`. Both surfaces accept:

```text
runtime/codex-command.ts run --base64url <script>
runtime/codex-command.ts status <run-id>
runtime/codex-command.ts tail <run-id> [stdout|stderr]
runtime/codex-command.ts errors <run-id>
runtime/codex-command.ts search <text> [run-id]
```

`status` returns only version 1
`skizzles.command-supervisor/run-status` documents. A document binds the exact
UTF-8 shell action by SHA-256 and a bounded label, never by retaining the raw
script. It records the shell, retention bounds, terminal or failed-start state,
cancellation signal, stream-drain result, and process-tree cleanup result.

## Retention and trust limits

The supervisor preserves child exit status, forwards termination signals,
bounds artifact storage and drain time, and writes status atomically in an
owner-only run store. `stdout.log` and `stderr.log` are separate owner-only,
size-bounded, unredacted artifacts. Callers must not treat them as sanitized.

The completed-artifact threshold is checked before each new run; it is not an
aggregate hard cap. A new run, status metadata, foreign entries, or concurrently
active runs may put the store over that threshold. Cleanup considers only
validated completed runs and never deletes active or unrecognized directories
to force the total down.

Status evidence carries unauthenticated SHA-256 integrity bindings for retained
byte prefixes while a run is active and exact files after termination. These
bindings detect mismatches but do not make the store authentic or tamper-proof:
the same operating-system user can coherently replace an artifact and its
status digest, and that replacement is accepted. Queries otherwise fail closed
on schema, version, permissions, byte-count, or evidence-digest mismatches.

Pre-v1 status files are unsupported. Runs live in a temporary bounded local
store and were never a documented interchange format; retaining a v0 reader
would preserve the raw-command disclosure removed by v1. The CLI command names
and argument forms remain unchanged.

The plugin builder bundles this package to the stable generated
`runtime/codex-command.ts` executable. Internal modules are not copied into a
plugin. The package has no runtime package dependencies.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
