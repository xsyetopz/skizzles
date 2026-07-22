# `@skizzles/prompt-policy`

Private package for the pinned Codex prompt baseline, Skizzles patch, derived
prompt policy assets, and their integrity-preserving lifecycle.

The public package entrypoint exports the offline build/check/patch APIs, the
networked immutable-commit rebase API, and the canonical-to-packaged asset map.
It also exports the strict parser and literal validator for the versioned
shipped-language evaluation corpus. Findings contain only taxonomy IDs and
bounded relative path/line locations.
Root `prompt:*` scripts execute `src/cli.ts` directly to expose the same
lifecycle. Canonical prompt assets live only under `assets/`; the plugin
builder stages their stable public destinations.

Each top-level prompt operation owns one disposable run workspace for Git patch
authoring and strict replay. Patch helpers receive named subdirectories from
that workspace; durable canonical assets, mutation locks, and transaction
journals remain under repository ownership and outside stale-run reclamation.

See [`docs/architecture.md`](docs/architecture.md) for the verified Codex
instruction semantics, provenance model, integrity guarantees, and maintainer
workflows.
