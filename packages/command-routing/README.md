# `@skizzles/command-routing`

This private package owns the approval-neutral `PreToolUse` hook that routes
supported noisy shell commands through Skizzles command observation. Plugin
packaging consumes it; application code should use it only to classify a script
or compose the canonical hook.

## Public surface and staged assets

- `@skizzles/command-routing` exports the import-safe `isManagedScript`
  classifier.
- `@skizzles/command-routing/hooks.json` exports the canonical descriptor from
  `assets/hooks.json`.
- `src/manage-command-output.ts` is the canonical executable source. Generated
  plugins stage it as `hooks/manage-command-output.ts`.

Importing the package does not run the hook. The classifier recognizes a
conservative shell subset and rewrites only supported commands that may produce
large output.

## Routing limits

The descriptor passes launch-time `${PLUGIN_ROOT}` as an explicit
`--plugin-root` argument. The hook requires an absolute plugin root containing
the staged supervisor and emits its concrete path with POSIX-safe shell
quoting. The replacement therefore does not depend on `PLUGIN_ROOT` remaining
in the command shell.

Missing, relative, or incomplete launch context leaves the original command
unchanged. The plugin builder stages
[`@skizzles/command-observation`](../command-observation/README.md) separately at
`runtime/codex-command.ts`. Classifier, normalization, policy, and command
contracts remain private under `src/manage-command-output/`.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
