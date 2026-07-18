# `@skizzles/command-hook`

Private Skizzles package for the approval-neutral `PreToolUse` command-output
hook. It recognizes a conservative shell subset and rewrites only supported,
potentially noisy commands to the generated plugin supervisor path.

## Entrypoints and assets

- `@skizzles/command-hook` exports the import-safe `isManagedScript`
  classifier.
- `skizzles-manage-command-output` executes `src/manage-command-output.ts`.
- `@skizzles/command-hook/hooks.json` exports the canonical descriptor stored
  at `assets/hooks.json`.

The emitted `${PLUGIN_ROOT}/runtime/codex-command.ts` path is the generated
plugin contract. The plugin builder stages the separate command-supervisor
package at that destination.

## Development

```sh
bun run typecheck
bun test
bun run check
```
