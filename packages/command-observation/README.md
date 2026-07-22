# `@skizzles/command-observation`

Private Skizzles package for durable command execution and retained-output
queries. The supervisor preserves the child exit status, forwards termination
signals, bounds artifact storage and drain time, and keeps status updates
atomic within an owner-only run store.

## Entrypoint

`@skizzles/command-observation` exports the import-safe `dispatchCommand` CLI
facade and a direct-argv `observeCommand` programmatic API. Importing either
does not dispatch an executable.

`observeCommand` accepts a strict versioned specification with an absolute
executable path, argument vector, working directory, complete environment,
timeout, per-stream byte cap, drain bound, signal grace bound, and optional
abort signal. It never accepts a shell command string. Its immutable receipt
binds the invocation and terminal outcome, preserving exit, signal, timeout,
abort, invalid-spec, spawn-failure, output-limit, stream-drain, and process-tree
cleanup states separately. Malformed or hostile specifications return a
no-spawn `invalid-spec` receipt with the fixed redacted `INVALID_SPEC` code;
they do not throw. Standard error is retained evidence and does not by itself
change a successful exit into a failure. Bounded output bytes are recovered
from an authentic receipt with `recoverCommandOutput`; callers receive a copy.

The source workspace executes the CLI directly with
`bun run packages/command-observation/src/codex-command.ts`; the generated
plugin exposes the stable `runtime/codex-command.ts` path. Both support:

```text
runtime/codex-command.ts run --base64url <script>
runtime/codex-command.ts status <run-id>
runtime/codex-command.ts tail <run-id> [stdout|stderr]
runtime/codex-command.ts errors <run-id>
runtime/codex-command.ts search <text> [run-id]
```

`status` returns only documents that validate as version 1
`skizzles.command-supervisor/run-status`. A document binds the exact
UTF-8 shell action by SHA-256 and a fixed bounded label; it never retains the
raw script. The document records the shell, size-based retention bounds,
terminal or failed-start state, cancellation signal, stream-drain result, and
process-tree cleanup result.

The retention policy caps each of `stdout.log` and `stderr.log` independently.
Its completed-artifact threshold is evaluated before a new run is created; it
is not an aggregate hard cap. The newly created run, status metadata, foreign
entries, and concurrently active runs can make the store exceed that threshold.
Cleanup considers only validated completed runs and never deletes an active or
unrecognized directory to force the threshold.

`stdout.log` and `stderr.log` are owner-only, size-bounded, operator-private
artifacts. They are explicitly classified as unredacted rather than described
as sanitized. Status evidence references contain unauthenticated SHA-256
integrity bindings for the retained byte prefixes while a run is active and the
exact files after termination. They detect mismatches but do not provide
authenticity or tamper-proof storage: the same operating-system user can rewrite
an artifact and its status digest coherently, and that coherent replacement is
accepted. Status queries fail closed when the schema, version, permissions,
byte counts, or recorded evidence digests do not match the observed artifacts.

Pre-v1 status files are intentionally unsupported. Runs live in a temporary,
bounded local store and were not a documented interchange format; retaining a
v0 reader would preserve the raw-command disclosure that v1 removes. The
command names and argument forms above remain unchanged.

The plugin builder bundles this package into the stable generated
`runtime/codex-command.ts` executable. Canonical internal modules are not copied
into generated plugins.

## Development

```sh
bun run typecheck
bun test
bun run check
```
