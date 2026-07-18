# `@skizzles/command-supervisor`

Private Skizzles package for durable command execution and retained-output
queries. The supervisor preserves the child exit status, forwards termination
signals, bounds artifact storage and drain time, and keeps status updates
atomic within an owner-only run store.

## Entrypoint

`@skizzles/command-supervisor` exports the import-safe `dispatchCommand`
programmatic facade. Calling it may write command output; importing it does not
dispatch the executable.

The `codex-command` binary executes `src/codex-command.ts` and supports:

```text
codex-command run --base64url <script>
codex-command status <run-id>
codex-command tail <run-id> [stdout|stderr]
codex-command errors <run-id>
codex-command search <text> [run-id]
```

`status` returns only documents that validate as version 1
`skizzles.command-supervisor/run-status`. A document binds the exact
UTF-8 shell action by SHA-256 and a fixed bounded label; it never retains the
raw script. The document records the shell, size-based retention bounds,
terminal or failed-start state, cancellation signal, stream-drain result, and
process-tree cleanup result.

`stdout.log` and `stderr.log` are owner-only, size-bounded, operator-private
artifacts. They are explicitly classified as unredacted rather than described
as sanitized. Status evidence references bind the retained byte prefixes while
a run is active and the exact files after termination. Status queries fail
closed when the schema, version, permissions, byte counts, or evidence digests
do not match.

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
