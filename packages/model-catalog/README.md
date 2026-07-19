# `@skizzles/model-catalog`

Private Skizzles package for producing and validating the optional Luna V2
model catalog, running isolated Codex catalog probes, storing catalog state
atomically, and rendering the macOS LaunchAgent template.

## Supported entrypoints

- Package export `@skizzles/model-catalog` exposes the stable overlay,
  refresh, and LaunchAgent-rendering facade from `src/index.ts`.
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
