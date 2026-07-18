# `@skizzles/model-catalog`

Private Skizzles package for producing and validating the optional Luna V2
model catalog, running isolated Codex catalog probes, storing catalog state
atomically, and rendering the macOS LaunchAgent template.

## Supported entrypoints

- Package export `@skizzles/model-catalog` exposes the stable overlay,
  refresh, and LaunchAgent-rendering facade from `src/index.ts`.
- Binary `skizzles-model-catalog` runs the same facade as a CLI with the
  `refresh`, `service`, and `render-launch-agent` commands.

All other files under `src/` are package internals. The canonical portable
LaunchAgent template is `assets/com.openai.skizzles-model-catalog.plist`; see
`docs/installation.md` for explicit host wiring. Plugin packaging bundles the
facade into the stable generated `runtime/model-catalog.ts` executable;
canonical internal modules are not copied into the plugin.
