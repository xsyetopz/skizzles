# Workspace architecture

Consequential architecture choices and their executable confirmation contracts are
recorded in the [architecture decision log](decisions/README.md). Source provenance and
Adopt/Adapt/Defer/Reject assessments for the cohesion campaign are maintained separately
in the [research decision ledger](research/architecture-ledger.md).

## Design

Skizzles uses a private Bun workspace with one package per executable or
independently testable TypeScript domain. The repository root is orchestration,
not an ambient source package. Package imports either remain internal or use an
explicit `workspace:*` dependency and exported entrypoint.

The current workspace dependency edges are:

```text
@skizzles/plugin-builder -> @skizzles/command-hook
@skizzles/plugin-builder -> @skizzles/command-supervisor
@skizzles/plugin-builder -> @skizzles/container-lab
@skizzles/plugin-builder -> @skizzles/installer
@skizzles/plugin-builder -> @skizzles/model-catalog
@skizzles/plugin-builder -> @skizzles/prompt-layer
@skizzles/plugin-builder -> @skizzles/usage-analyzer
@skizzles/installer -> @skizzles/container-lab
@skizzles/installer -> @skizzles/prompt-layer
```

The plugin builder is the explicit composition owner for all seven canonical
workspace packages whose public entrypoints or assets it distributes. Other runtime
relationships cross process boundaries rather than TypeScript imports. The installer
consumes provider-owned Container Lab and prompt-layer descriptor locations through
their explicit package exports; it does not traverse sibling private filesystem paths.

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
- only supported `exports` and optional `bin` entrypoints.

The pinned Bun 1.3.14 isolated linker chmods a dereferenced workspace `bin`
target when another workspace package consumes its owner. Consumed packages
therefore expose canonical executable sources through repository scripts and
the deterministic generated plugin instead of package-manager binaries.
Standalone repository tooling may retain a deliberate `bin`; workspace policy
rejects only the unsafe dependency shape and continues to validate every
declared target, build/import lifecycle, public-surface budget, and executable
entrypoint thickness.

`@skizzles/workspace-policy` verifies these requirements, scans imports for
dependency and containment violations, compiles declared TypeScript entrypoints
in memory, imports TypeScript exports in isolated processes to reject
import-time exit, stdio effects, lifecycle hangs, and POSIX same-group
descendants, rejects nested lockfiles/build-info, and rejects TypeScript sources
outside a workspace package. The import gate is lifecycle validation for
trusted code, not a malicious-code sandbox: deliberate session re-detachment
can escape POSIX group containment, and Windows cannot perform negative-PGID
descendant detection.

## Toolchain

- Bun: version pinned by `packageManager` and CI.
- TypeScript: shared strict policy in `tsconfig.base.json`; packages own direct
  compiler and environment type dependencies.
- Biome: version 2.5.4 invoked through `bunx`; no local Biome dependency.
- Lockfile: root `bun.lock` only, using Bun's isolated linker.
- Repository verification: `@skizzles/workspace-policy` acquires checksum-pinned
  actionlint 1.7.12, ShellCheck 0.11.0, and Gitleaks 8.30.1 only in disposable
  directories for the mandatory CI/release `security:check`; no binary is vendored
  or installed persistently.

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
