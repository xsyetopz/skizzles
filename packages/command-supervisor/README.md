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

The plugin builder bundles this package into the stable generated
`runtime/codex-command.ts` executable. Canonical internal modules are not copied
into generated plugins.

## Development

```sh
bun run typecheck
bun test
bun run check
```
