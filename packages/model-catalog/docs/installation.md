# Optional Luna V2 model catalog

This host-wiring surface is for owners who have independently verified Luna with MultiAgentV2. It preserves the complete official catalog and changes only `gpt-5.6-luna.multi_agent_version` from `v1` to `v2`. It is intentionally separate from ordinary skill/plugin installation.

## Generate and inspect

Choose the Codex binary that owns app-server and run the canonical package
entrypoint:

```sh
/absolute/path/to/bun /absolute/path/to/packages/model-catalog/src/index.ts refresh \
  --codex-home /absolute/path/to/.codex \
  --codex-binary /absolute/path/to/codex
```

The default output is `CODEX_HOME/skizzles/model-catalog.json`; bounded status is written beside it. The generator uses a normal cache only when its complete SemVer, including prerelease and build metadata, exactly matches the selected binary, its timestamp is within Codex's five-minute TTL, and it contains the expected complete model family. Otherwise it invokes `codex debug models --bundled`. Before replacing the last-known-good output, it makes the selected binary load the completed catalog. Every version, bundled-catalog, and preflight command receives a distinct disposable credential-free `HOME`, `CODEX_HOME`, temporary directory, and XDG directory set plus a minimal environment. Each detached process group has a hard deadline, bounded streams, TERM grace, KILL fallback, and cleanup on success or failure. Raw child output and errors are never copied into service diagnostics. The generator does not read, copy, or refresh authentication.

The command line requires every path value to be a nonempty absolute path and rejects unknown options, duplicate options, positional arguments, and missing values. Existing path components must be physical rather than symlinked. Catalog storage directories are owner-owned with mode `0700`; managed catalog, status, cache, and staged files are single-link files with mode `0600`. External hard links are rejected before permission repair, reads, no-op decisions, or promotion. This is fail-closed host wiring: correct the path or invocation rather than relying on implicit resolution or ignored arguments.

Atomic promotion revalidates parent and target identities plus all catalog-path aliases immediately before rename, then synchronizes the file and parent directory. Bun's pathname APIs do not expose a directory-file-descriptor `openat`/`renameat` transaction, so this resists accidental or cooperating replacement but does not claim race-free containment against a hostile local process that can rewrite owner-controlled directories between the final check and rename.

Verify that the output contains every expected model and exactly one Luna entry marked V2. Configure Codex with the absolute generated path:

```toml
model_catalog_json = "/absolute/path/to/.codex/skizzles/model-catalog.json"
```

The custom catalog is authoritative and startup-only. `catalogChanged: true` reports a change made by that specific refresh; `generation` is the stable SHA-256 identity of the current catalog. Restart app-server after a reported change; existing tasks retain their initial catalog and tool schema.

## Render and load the LaunchAgent on macOS

Render the portable template into the user's LaunchAgents directory using
absolute Bun, package, and Codex paths:

```sh
/absolute/path/to/bun /absolute/path/to/packages/model-catalog/src/index.ts render-launch-agent \
  --template /absolute/path/to/packages/model-catalog/assets/com.openai.skizzles-model-catalog.plist \
  --output /absolute/path/to/Library/LaunchAgents/com.openai.skizzles-model-catalog.plist \
  --bun /absolute/path/to/bun \
  --script /absolute/path/to/packages/model-catalog/src/index.ts \
  --codex-home /absolute/path/to/.codex \
  --codex-binary /absolute/path/to/codex
```

Validate the rendered file with `plutil -lint`, then deliberately load it with `launchctl bootstrap gui/UID PLIST`. The one-shot service runs at load, every five minutes, and when the normal cache or selected binary changes. It applies an owner-only umask, is silent under launchd, and replaces one bounded status file instead of accumulating service logs. It never restarts app-server automatically.

The generated plugin preserves the stable bundled destinations
`runtime/model-catalog.ts`, `assets/com.openai.skizzles-model-catalog.plist`, and
`assets/model-catalog-installation.md`. When wiring from a plugin snapshot,
use those bundled paths instead of the canonical package paths above.

## Rollback

Unload and remove the rendered LaunchAgent, remove `model_catalog_json` from global configuration, and restart app-server. Retain the generated catalog until the restart succeeds; deleting it while configuration still references it makes startup fail closed. The normal remote/cache-backed model manager resumes after the override is removed.
