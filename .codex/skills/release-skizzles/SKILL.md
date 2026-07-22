---
name: release-skizzles
description: Prepare a safe aligned Skizzles release without publishing or changing a live installation.
---

# Release Skizzles

Release only from a clean, validated canonical workspace. Versioning, generated
output, publication, and live activation are distinct decisions.

## Align

1. Obtain the exact target version and destination.
2. Update `package.json`, every workspace package manifest, and `packages/plugin-packaging/template/.codex-plugin/plugin.json` to the same version.
3. Run `bun install` once to update the sole root `bun.lock`, then prove `bun install --frozen-lockfile`.
4. Run `bun run workspace:check` to reject missing packages, version drift, dependency leakage, or invalid exports.

## Validate

1. Run `bun run plugin:check` and record expected pre-regeneration drift.
2. Run `bun run plugin:build`, then `bun run plugin:check`.
3. Run `bun run verify` and reproduce it from a clean checkout.
4. From a full-history checkout, run `bun run security:check` exactly once; this
   networked gate is separate from `verify` and fails closed on acquisition,
   checksum, workflow, tree, or history-scan failure.
5. Inspect source, lockfile, and generated diffs for the intended version only.

## Release gate

Hand the validated version, evidence, and remaining tag/publication/cutover steps
to the release owner. Do not tag, publish, install, or change host state without
explicit authorization.
