---
name: package-skizzles
description: Build and validate the Skizzles plugin from canonical workspace inputs.
---

# Package Skizzles

Use this maintainer skill when changing the versioned plugin distribution.
Canonical packages and skills are the source. `plugins/skizzles/` is generated
output and must not be edited directly.

## Before building

1. Inspect `package.json`,
   `packages/plugin-packaging/template/.codex-plugin/plugin.json`,
   `.agents/plugins/marketplace.json`, and `git status`.
2. Run `bun install --frozen-lockfile` and `bun run workspace:check`.
3. Check package inputs for Finder metadata, machine paths, credentials, and
   other local state. Do not alter a live Codex home, installed plugin, `PATH`,
   launchd, Docker, or Container Lab state.

## Build and verify

1. Run `bun run plugin:check` to record any existing drift.
2. Run `bun run plugin:build`.
3. Run `bun run plugin:check` again.
4. Run `bun run test:packaging` and the tests for changed packages.
5. Run `bun run verify` for the full workspace gate.
6. Inspect the generated diff. If it is wrong, fix canonical inputs and
   rebuild. Never patch files under `plugins/skizzles/`.

## Handoff

Report the canonical changes, generated files, commands and results, and any
separate release or installation decision. Packaging does not publish, tag,
install, or activate host wiring.
