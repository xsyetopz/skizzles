# `@skizzles/prompt-layer`

Private package for the pinned Codex prompt baseline, Skizzles patch, derived
prompt policy assets, and their integrity-preserving lifecycle.

The public package entrypoint exports the offline build/check/patch APIs, the
networked immutable-commit rebase API, and the canonical-to-packaged asset map.
It also exports the strict parser and literal validator for the versioned
shipped-language evaluation corpus. Findings contain only taxonomy IDs and
bounded relative path/line locations.
The `skizzles-prompt-layer` binary exposes the same lifecycle to repository
scripts. Canonical prompt assets live only under `assets/`; the plugin builder
stages their stable public destinations.

See [`docs/architecture.md`](docs/architecture.md) for the verified Codex
instruction semantics, provenance model, integrity guarantees, and maintainer
workflows.
