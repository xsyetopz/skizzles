# `@skizzles/prompt-policy`

This private package owns the pinned Codex prompt baseline, the Skizzles patch,
derived prompt-policy assets, and their integrity-preserving lifecycle.
Maintainers use it to build, verify, author, or rebase canonical prompt assets;
the installer consumes its portable descriptor and generated outputs.

Repository tooling does not activate prompt policy on a host. Activation is a
separate explicit installer operation documented in the
[architecture guide](docs/architecture.md#supported-installer-activation-behavior).

## Public API and commands

The package entrypoint exports `buildPrompt`, `checkPrompt`,
`authorPromptPatch`, and `rebasePrompt`, along with patch validation,
immutable-commit parsing, canonical-to-packaged asset maps, and the strict
shipped-language corpus parser and validator. Findings contain only taxonomy
IDs and bounded relative path and line locations.

Root scripts expose the same lifecycle:

```sh
bun run prompt:build
bun run prompt:check
bun run prompt:patch -- [candidate-path]
bun run prompt:rebase -- <40-hex-commit>
```

Build, check, and patch authoring are offline. Rebase is the only networked
operation and accepts an immutable lowercase 40-hex Codex commit. The
[command table](docs/architecture.md#commands-and-network-boundary) describes
the write sets and review boundary for each operation.

## Assets and runtime limits

Canonical prompt inputs live only under `assets/`; the plugin builder stages
their stable public destinations. Each top-level operation uses one disposable
[`@skizzles/scratchspace`](../scratchspace/README.md) run workspace for Git
patch authoring and strict replay. Durable canonical assets, mutation locks,
and transaction journals remain under repository ownership and outside
stale-run reclamation.

The package has no network access except through the immutable rebase fetcher.
It depends on `@skizzles/scratchspace`; plugin distribution is owned by
[`@skizzles/plugin-packaging`](../plugin-packaging/README.md).

Read [the prompt-layer architecture](docs/architecture.md) for verified Codex
instruction semantics, provenance, integrity and mutation guarantees,
maintainer workflows, and installer behavior.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```

From the repository root, `bun run prompt:check` is the non-writing check for
the canonical prompt asset set.
