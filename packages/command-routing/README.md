# `@skizzles/command-routing`

Private Skizzles package for the approval-neutral `PreToolUse` command-output
hook. It recognizes a conservative shell subset and rewrites only supported,
potentially noisy commands to the generated plugin supervisor path.

## Entrypoints and assets

- `@skizzles/command-routing` exports the import-safe `isManagedScript`
  classifier.
- `src/manage-command-output.ts` is the canonical executable source composed by
  the plugin builder; the generated plugin exposes it at
  `hooks/manage-command-output.ts`.
- `@skizzles/command-routing/hooks.json` exports the canonical descriptor stored
  at `assets/hooks.json`.

The hook descriptor passes the launch-time `${PLUGIN_ROOT}` as an explicit
`--plugin-root` argument. The hook validates that this is an absolute plugin
root containing the staged supervisor, then emits its concrete path with
POSIX-safe shell quoting. The replacement command therefore does not depend on
`PLUGIN_ROOT` remaining present in the command shell. Missing, relative, or
incomplete launch context fails closed without rewriting the original command.
The plugin builder stages the separate command-observation package at
`runtime/codex-command.ts`.

The source path is also the plugin builder's canonical staging contract.
Its classifier, normalization, policy, and command contract are privately owned
under `src/manage-command-output/`; generated hooks retain their existing path.

## Development

```sh
bun run typecheck
bun test
bun run check
```
