# Skizzles maintainer guide

Skizzles is a Bun/TypeScript packaging workspace, not a live installation.
Canonical packages are portable; `plugins/skizzles/` is their deterministic
distribution output.

## Architecture and ownership

- The root owns workspace discovery, `bun.lock`, `tsconfig.base.json`,
  `biome.jsonc`, aggregate scripts, marketplace metadata, and repository-wide
  policy only.
- Every production TypeScript domain owns `package.json`, `src/`, `test/`,
  `tsconfig.json`, `README.md`, direct dependencies, and intentional exports or
  binaries under `packages/`.
- `packages/plugin-builder/` is the sole plugin staging authority.
  `packages/prompt-layer/` owns prompt inputs and provenance.
- Root `assets/` owns portable native instruction and role assets used by the
  optional installer instruction profile; the package builder stages them into
  generated output.
- `skills/` is canonical public skill content. Repo-local `.codex/skills/` is
  maintainer guidance and is not public unless packaging explicitly includes it.
- Never hand-edit `plugins/skizzles/`. Rebuild it from canonical packages and
  prove parity with `plugin:check`.
- Keep the root `bun.lock` as the only lockfile. Do not add nested locks,
  build-info files, or undeclared root dependencies.

See [`docs/workspace-architecture.md`](docs/workspace-architecture.md) for the
complete package-to-artifact map.

## TypeScript and tooling

- Use strict, erasable TypeScript with typed trust-boundary parsers, exhaustive
  state handling, deterministic errors, `.ts` relative imports, and no
  accidental `any`, unchecked assertions, non-null assertions, or cross-package
  relative imports.
- Public package entrypoints must be explicit; internals remain unexported.
- Biome 2.5.4 is mandatory through `bunx`. Do not install Biome in any manifest.
- Tests live with their owning package and prove contracts, negative cases, and
  relevant runtime entrypoints.

## Safety

- Do not mutate a real Codex home, installed plugin, live hooks, `PATH`, launchd,
  or another host environment during repository development.
- Keep Finder metadata ignored and absent; do not stage, normalize, or
  distribute it.
- Distributables must contain no machine paths, credentials, symlinks, caches,
  logs, databases, build output, or live state.
- Preserve unrelated work. The root integration owner alone creates Git
  checkpoints after coherent, validated slices.

## Validation

All build, test, packaging, release, and drift validation is local-first. Do not
create, modify, enable, trigger, or require hosted CI for repository work unless
the owner explicitly requests it; run the equivalent local commands instead.

Run the narrowest package check first. For package inputs or workspace changes,
run:

```sh
bun run workspace:check
bun run check
bun run typecheck
bun run test
bun run packages:build
bun run plugin:check
```

For generated changes, record pre-build drift, run `bun run plugin:build`, then
rerun `bun run plugin:check` and inspect the generated diff. Final acceptance
uses `bun run verify` from the aggregate tree and a clean-checkout reproduction.

Read [README.md](README.md) for installation surfaces and
[profiles/AGENTS.md](profiles/AGENTS.md) for the optional portable policy.
