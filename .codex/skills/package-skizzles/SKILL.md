---
name: package-skizzles
description: Stage, inspect, and validate the Skizzles versioned plugin from its canonical source workspace.
---

# Package Skizzles

Package only from canonical workspace packages. `plugins/skizzles/` is generated
and must never be repaired directly.

## Prepare

1. Inspect `package.json`, `packages/plugin-packaging/template/.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, and `git status`.
2. Run `bun install --frozen-lockfile` and `bun run workspace:check`.
3. Keep the tracked root `.DS_Store` untouched and remove Finder metadata or local state from package inputs.
4. Do not mutate a live Codex directory, installed plugin, `PATH`, launchd, or Container Lab state.

## Stage and verify

1. Run `bun run plugin:check` before regeneration to expose existing drift.
2. Run `bun run plugin:build`, then `bun run plugin:check`.
3. Run `bun run test:packaging` for packaging changes and the owning package tests for changed inputs.
4. Run `bun run verify` for the complete workspace boundary.
5. Inspect the generated diff. Correct canonical inputs and rebuild; never patch generated files.

## Hand off

Report canonical changes, generated artifacts, validation evidence, and any
separate release or live-install decision. Do not publish, tag, install, or
activate host wiring without explicit approval.
