# `@skizzles/model-catalog`

This private package produces and validates the optional Luna V2 model catalog,
runs isolated Codex catalog probes, stores catalog state atomically, and renders
the macOS LaunchAgent template. Use it only after independently verifying Luna
with MultiAgentV2; ordinary Skizzles installation does not need this catalog.

## Supported entrypoints

- Package export `@skizzles/model-catalog` exposes `applyLunaV2Overlay`,
  `refreshCatalog`, and `renderLaunchAgent` from `src/index.ts`.
- `bun run packages/model-catalog/src/index.ts` runs the same facade as a CLI
  with the `refresh`, `service`, and `render-launch-agent` commands; generated
  plugins expose the dependency-self-contained `runtime/model-catalog.ts` path.

All other files under `src/` are package internals. The canonical portable
LaunchAgent template is `assets/com.openai.skizzles-model-catalog.plist`; see
`docs/installation.md` for explicit host wiring. Plugin packaging bundles the
facade into the stable generated `runtime/model-catalog.ts` executable;
canonical internal modules are not copied into the plugin.

## Runtime lifecycle

Refresh probes currently require Unix detached process-group ownership. Windows
refresh fails before stale cleanup, filesystem mutation, or child spawn until a
Job Object-backed whole-tree adapter is implemented; direct-PID termination is
not treated as process-group ownership.

Durable output promotion is the cancellation commit point. Cancellation checked
immediately before that atomic rename leaves the previous output and status
unchanged. Once output promotion succeeds, refresh finishes the matching bounded
status document even if cancellation arrives afterward, so consumers never
observe a cancellation-induced output/status half-commit.

## Dependencies and verification

The package depends on
[`@skizzles/scratchspace`](../scratchspace/README.md) for isolated probe homes
and cleanup. Refresh also needs an explicit Codex binary and Codex home. It does
not select credentials, copy authentication into probe homes, restart
app-server, or activate the rendered LaunchAgent.

Run package checks from this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```

Host wiring, rollback, and the exact `refresh` and `render-launch-agent`
commands are documented in the [installation guide](docs/installation.md).
