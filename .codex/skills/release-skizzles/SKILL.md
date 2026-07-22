---
name: release-skizzles
description: Prepare a validated Skizzles release without publishing or changing a live installation.
---

# Release Skizzles

Use this maintainer skill when preparing a versioned release. Versioning,
plugin generation, publication, and host activation are separate actions.

## Align the version

1. Confirm the exact target version and destination.
2. Update the root manifest, every workspace package manifest, and
   `packages/plugin-packaging/template/.codex-plugin/plugin.json`.
3. Run `bun install` once, then prove `bun install --frozen-lockfile`.
4. Run `bun run workspace:check` to catch missing packages, version drift,
   dependency leakage, and invalid exports.

## Validate the release

1. Run `bun run plugin:check` and record expected pre-build drift.
2. Run `bun run plugin:build`, then `bun run plugin:check`.
3. Run `bun run verify` and reproduce it from a clean checkout.
4. From a full-history checkout, run `bun run security:check` once. This gate
   acquires pinned tools and fails closed on acquisition, checksum, workflow,
   tree, or history-scan errors.
5. Inspect source, lockfile, and generated diffs. They should contain only the
   intended version change.

## Handoff

Hand off the validated version and evidence to the release owner. Do not tag,
publish, install, or change host state without explicit authorization.
