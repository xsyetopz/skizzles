# Workspace architecture

## Design

Skizzles uses a private Bun workspace with one package per executable or
independently testable TypeScript domain. The repository root is orchestration,
not an ambient source package. Package imports either remain internal or use an
explicit `workspace:*` dependency and exported entrypoint.

The only current workspace dependency edge is:

```text
@skizzles/plugin-builder -> @skizzles/prompt-layer
```

Other runtime relationships cross process or packaging boundaries rather than
TypeScript imports.

## Canonical and generated paths

| Canonical owner | Generated plugin surface |
| --- | --- |
| `packages/command-hook` | `hooks/hooks.json`, bundled `hooks/manage-command-output.ts` |
| `packages/command-supervisor` | bundled `runtime/codex-command.ts` |
| `packages/model-catalog` | bundled `runtime/model-catalog.ts`, model-catalog assets |
| `packages/usage-analyzer` | bundled `scripts/analyze.ts` |
| `packages/installer` | bundled `packages/installer/src/cli.ts` and runtime manifest |
| `packages/container-lab` | bundled `packages/container-lab/src/{cli,reaper-cli}.ts`, descriptor, docs, and LaunchAgent template |
| `packages/prompt-layer` | `instructions/`, `integrations/prompt-policy.json`, and `third_party/openai-codex/` |
| `skills/` | `skills/` |
| `packages/plugin-builder/template` | plugin manifest and static template assets |

Bundled entrypoints preserve supported public paths while omitting canonical
internal module trees, tests, development dependencies, and build output.
Generated bundles are never source authority.

## Package contract

Every workspace package declares:

- a private ESM manifest and aligned version;
- its direct runtime and development dependencies;
- strict package-local TypeScript scope;
- `src/`, `test/`, and package documentation;
- deterministic `build`, pinned `check`, `typecheck`, and `test` scripts;
- only supported `exports` and `bin` entrypoints.

`@skizzles/workspace-policy` verifies these requirements, scans imports for
dependency and containment violations, compiles declared TypeScript entrypoints
in memory, rejects nested lockfiles/build-info, and rejects TypeScript sources
outside a workspace package.

## Toolchain

- Bun: version pinned by `packageManager` and CI.
- TypeScript: shared strict policy in `tsconfig.base.json`; packages own direct
  compiler and environment type dependencies.
- Biome: version 2.5.4 invoked through `bunx`; no local Biome dependency.
- Lockfile: root `bun.lock` only, using Bun's isolated linker.

## Packaging and hygiene

The plugin builder stages into a temporary directory, validates prompt and
Container Lab contracts, bundles executable entrypoints, validates CLI smokes,
checks manifest/marketplace/hook paths, and rejects symlinks, Finder metadata,
credentials, machine paths, caches, logs, databases, and unsupported local
state. `plugin:check` compares the complete staged tree, including file modes,
with `plugins/skizzles/`.

Release preparation updates aligned canonical versions, regenerates the plugin,
and runs aggregate validation. Publication, tagging, installation, and host
activation are separate owner decisions.
