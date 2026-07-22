# Workspace architecture

This document is the current map of package ownership, dependency direction,
lifecycle boundaries, and generated plugin output. Read it before moving code,
adding a package, or changing a distribution path. The
[architecture decision log](decisions/README.md) explains why these boundaries
exist, and the [architecture research ledger](research/architecture-ledger.md)
records the source evidence behind the initial cohesion campaign.

## Package topology and dependency direction

Skizzles uses a private Bun workspace with one package per executable or
independently testable TypeScript domain. The repository root is orchestration,
not an ambient source package. Package imports either remain internal or use an
explicit `workspace:*` dependency and exported entrypoint.

The current workspace dependency edges are:

<!-- workspace-governance:dependency-edges:start -->
```text
@skizzles/acceptance -> @skizzles/candidate-manifest
@skizzles/change-assurance -> @skizzles/candidate-manifest
@skizzles/change-assurance -> @skizzles/scratchspace
@skizzles/installer -> @skizzles/container-lab
@skizzles/installer -> @skizzles/prompt-policy
@skizzles/installer -> @skizzles/scratchspace
@skizzles/model-catalog -> @skizzles/scratchspace
@skizzles/orchestrator -> @skizzles/acceptance
@skizzles/orchestrator -> @skizzles/candidate-manifest
@skizzles/orchestrator -> @skizzles/change-assurance
@skizzles/orchestrator -> @skizzles/reflexion-memory
@skizzles/orchestrator -> @skizzles/source-transformation
@skizzles/orchestrator -> @skizzles/task-worktree
@skizzles/orchestrator -> @skizzles/workspace-publication
@skizzles/plugin-packaging -> @skizzles/command-observation
@skizzles/plugin-packaging -> @skizzles/command-routing
@skizzles/plugin-packaging -> @skizzles/container-lab
@skizzles/plugin-packaging -> @skizzles/installer
@skizzles/plugin-packaging -> @skizzles/model-catalog
@skizzles/plugin-packaging -> @skizzles/prompt-policy
@skizzles/plugin-packaging -> @skizzles/scratchspace
@skizzles/plugin-packaging -> @skizzles/usage-analysis
@skizzles/prompt-policy -> @skizzles/scratchspace
@skizzles/source-transformation -> @skizzles/candidate-manifest
@skizzles/source-transformation -> @skizzles/scratchspace
@skizzles/task-worktree -> @skizzles/candidate-manifest
@skizzles/task-worktree -> @skizzles/command-observation
@skizzles/workspace-governance -> @skizzles/scratchspace
```
<!-- workspace-governance:dependency-edges:end -->

The plugin builder is the explicit composition owner for all seven canonical
workspace packages whose public entrypoints or assets it distributes.
`@skizzles/scratchspace` is a supporting lifecycle dependency used during
composition; it is not an eighth distributed plugin surface. The installer consumes
provider-owned Container Lab and prompt-policy descriptor locations through their
explicit package exports; it does not traverse sibling private filesystem paths.

`@skizzles/orchestrator` owns deterministic agent-request policy and execution
contracts. Its Phase 1 surface is dependency-free and is not yet a distributed
plugin runtime. Later lifecycle and validation phases must depend on existing
capability owners through public package exports or injected ports; the plugin
builder remains the only distribution composition owner.

Its academic-paradigm router defaults to a linear Locate, Patch, Verify
controller and admits ReAct only behind a host-owned step ledger. The router
composes a closed command catalog, structured process results, dependency and
path-aware scheduling, protected context placement, optional auditable
compression, and cross-task failure memory before any injected model dispatch.
It exposes no generic shell and owns no live model endpoint.

Routing experiments remain split across the same boundaries. The host supplies
an explicit candidate assignment and the orchestrator binds it to dispatch and
pre-approval digest evidence through an optional observer; it never selects a
live endpoint. `@skizzles/usage-analysis` owns the strict in-memory evidence learner,
which compares complete workflow tokens per independently verified success only
inside comparable strata and treats AAII/price values as metadata priors.

`@skizzles/workspace-publication` owns repository-scoped publication leases,
destination-owned same-filesystem siblings, durable multi-file journals, and
deterministic recovery. It provides serialized per-file atomic publication and
recoverable file-set semantics; it does not claim portable multi-file atomicity.
The orchestrator owns workflow policy and approval. Task-worktree composes
command-observation's process observation behind its sandbox broker;
scratchspace retains disposable-root lifecycle and quota evidence for its
remaining consumers. Neither capability is a direct orchestrator dependency.

`@skizzles/source-transformation` owns language-specific source transformation and
validation. It derives immutable candidates through compiler AST nodes, keeps
symbol indexes advisory to compiler results, and binds template, formatter,
policy, and semantic-diff provenance. The orchestrator composes that evidence
with approval and publication; source-transformation never writes the canonical
workspace.

`@skizzles/candidate-manifest` owns the canonical versioned identity shared by
source engineering, change assurance, and task worktrees for an exact candidate
file set. A manifest contains only sorted normalized relative paths, write or
delete operations, and content digests; it contains no source bytes or host
paths and does not claim caller authority. Each consuming capability derives
and authenticates the same manifest independently while retaining its own
native candidate digest domain.

`@skizzles/reflexion-memory` owns immutable cross-task failure records backed by
either an injected persistence authority or its explicit strict local SQLite
adapter. Read-only snapshots and append-only recording are separate
capabilities; snapshots exclude the consuming task's records, and
skill-directory references remain inert structured data. The package does not
construct prompts, execute skills, select an ambient database path, or let an
active task read the critique it records.

`@skizzles/change-assurance` owns pre-publication non-functional, security,
migration, secret, performance, dependency, vulnerability, and license
assurance. Trusted hosts issue authentic change declarations; four dedicated
domain authorities assess exact baseline and candidate bytes and produce one
digest-only receipt. The orchestrator runs this boundary after source
preparation and before physical integration or approval.

`@skizzles/task-worktree` owns task-scoped Git branch and worktree lifecycle,
exact declared-path candidate writes, host-owned diff ceilings, sandbox
capability negotiation and execution, dependency intervention evidence, and
deterministic Conventional Commit synthesis. It creates one approved commit in
the isolated branch; `@skizzles/workspace-publication` remains the only owner of
canonical destination publication. Unsupported OS sandbox enforcement fails
closed instead of degrading to unsandboxed execution.

`@skizzles/acceptance` owns Phase 6 acceptance aggregation. It derives
the complete mutation objective from authenticated modified executable maps,
requires deterministic property and modified-node/branch coverage evidence,
proves the original test manifest ran against the candidate production overlay,
and invokes a distinct reviewer last. It does not edit source, execute commands,
inspect Git, or rerun another package's verifier. The orchestrator composes its
receipt only after source engineering, change assurance, security review,
physical integration, and task-worktree validation have produced authentic,
exactly bound evidence.

## Run lifecycle ownership

| Lifecycle role | Owner or consumers | Contract |
| --- | --- | --- |
| Disposable creator | `@skizzles/scratchspace` | Sole authority for creating, claiming, preserving, closing, and stale-reaping one-run temporary roots. |
| Task Git isolation | `@skizzles/task-worktree` | Owns deterministic task branches, isolated worktrees, sibling writable roots, sandboxed validation, approved isolated commits, and exact cleanup. These roots are not generic disposable workspaces. |
| Injected consumers | `@skizzles/installer`, `@skizzles/model-catalog`, `@skizzles/plugin-packaging`, `@skizzles/prompt-policy`, `@skizzles/workspace-governance` | Allocate run-local homes, previews, comparison staging, downloads, reports, and validation artifacts only through an injected or composition-root-created `RunWorkspace`. Same-filesystem destination transactions and their atomic siblings remain destination-owned rather than scratchspace staging. |
| Child-scope owners | Installer Codex app-server, model-catalog Codex probes, plugin-packaging runtime smokes, and workspace-governance security tools | Register the complete owned process scope before awaiting it; workspace close requests stop, waits, escalation, and only then root deletion. |
| Durable exclusions | Canonical repository inputs, `plugins/skizzles/`, selected-home config/receipts and model-catalog output/status, installer prompt-policy locks, command-observation retained output, Container Lab durable manifests, same-filesystem destination transactions and atomic siblings, and separately owned shared caches | Never place durable authority in a disposable run root. Each surface retains its canonical package or host-state owner and separate retention policy. |

## Canonical and generated paths

| Canonical owner | Generated plugin surface |
| --- | --- |
| `packages/command-routing` | `hooks/hooks.json`, bundled `hooks/manage-command-output.ts` |
| `packages/command-observation` | bundled `runtime/codex-command.ts` |
| `packages/model-catalog` | bundled `runtime/model-catalog.ts`, model-catalog assets |
| `packages/usage-analysis` | bundled `scripts/analyze.ts` |
| `packages/installer` | bundled `packages/installer/src/cli.ts` and runtime manifest |
| `packages/container-lab` | bundled `packages/container-lab/src/{cli,reaper-cli}.ts`, descriptor, docs, and LaunchAgent template |
| `packages/prompt-policy` | `instructions/`, `integrations/prompt-policy.json`, `evaluations/shipped-language-policy.v2.json`, and `third_party/openai-codex/` |
| `assets/` | portable native root instructions and Fourth Wall role configuration assets |
| `skills/` | `skills/` |
| `packages/plugin-packaging/template` | plugin manifest and static template assets |

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

`@skizzles/workspace-governance` verifies these requirements, scans imports for
dependency and containment violations, compiles declared TypeScript entrypoints
in memory, imports TypeScript exports in isolated processes to reject
import-time exit, stdio effects, lifecycle hangs, and POSIX same-group
descendants, rejects nested lockfiles/build-info, and rejects TypeScript sources
outside a workspace package. The import gate is lifecycle validation for
trusted code, not a malicious-code sandbox: deliberate session re-detachment
can escape POSIX group containment, and Windows cannot perform negative-PGID
descendant detection.

## Pinned toolchain

- Bun: version pinned by `packageManager` and CI.
- TypeScript: shared strict policy in `tsconfig.base.json`; packages own direct
  compiler and environment type dependencies.
- Biome: version 2.5.4 invoked through `bunx`; no local Biome dependency.
- Lockfile: root `bun.lock` only, using Bun's isolated linker.
- Repository verification: `@skizzles/workspace-governance` acquires checksum-pinned
  actionlint 1.7.12, ShellCheck 0.11.0, and Gitleaks 8.30.1 only in disposable
  directories for the mandatory CI/release `security:check`; no binary is vendored
  or installed persistently.

## Plugin construction and release boundary

The plugin builder constructs output through a same-filesystem destination transaction.
Comparison staging, prompt checks, and runtime validation share one owned run workspace;
the destination transaction remains target-owned so atomic promotion is preserved. The
builder validates prompt and Container Lab contracts, bundles executable entrypoints,
validates CLI smokes, checks manifest/marketplace/hook paths, and rejects symlinks,
Finder metadata, credentials, machine paths, caches, logs, databases, and unsupported
local state. `plugin:check` compares the complete staged tree, including file modes,
with `plugins/skizzles/`.

Release preparation updates aligned canonical versions, regenerates the plugin,
and runs aggregate validation. Publication, tagging, installation, and host
activation are separate owner decisions.
