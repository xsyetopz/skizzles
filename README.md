# Skizzles

![Skizzles logo](packages/plugin-builder/template/assets/logo.png)

Skizzles is a portable Codex engineering harness distributed as a deterministic
plugin. Its canonical implementation is a Bun workspace of strict TypeScript
packages; `plugins/skizzles/` is generated output.

## Capabilities

- reusable Codex skills and native Fourth Wall orchestration guidance;
- evidence-driven routing experiments with independently verified workflow
  measurements;
- a permission-neutral command hook and bounded command supervisor;
- privacy-preserving rollout usage analysis;
- disposable Docker Compose Container Lab tooling;
- a validated model-catalog overlay with explicit host activation;
- reversible Codex configuration and prompt-policy installers;
- optional split native instruction/agent-role assets for default, triage,
  worker, designer, QA, review, and deployment workflows;
- checksum-locked derivation of the Codex base-instruction layer.

## Workspace

Production TypeScript is owned by packages under `packages/`. The FastMCP
project template is also an explicit workspace at
`skills/codex-project-tooling/assets/fastmcp-bun-template` so it cannot depend
on undeclared root packages.

| Package | Responsibility |
| --- | --- |
| `candidate-manifest` | Canonical versioned identity for exact candidate file paths, operations, and content digests |
| `change-assurance` | Authentic pre-publication security, migration, performance, and supply-chain evidence |
| `command-hook` | Hook event validation and command classification |
| `command-supervisor` | Bounded process execution, artifacts, retention, and queries |
| `container-lab` | Container Lab CLI, reaper, durable state, synchronization, and docs |
| `installer` | Skills/harness install, Codex configuration, doctor, and prompt-policy lifecycle |
| `model-catalog` | Isolated catalog refresh and LaunchAgent rendering |
| `orchestrator` | Deterministic request policy, evidence checkpoints, structural review, and bounded paradigm routing |
| `plugin-builder` | Deterministic plugin staging, bundling, validation, and drift checks |
| `prompt-layer` | Pinned upstream prompt, patch derivation, provenance, and recovery |
| `reflexion-memory` | Immutable cross-task failure memory with separate read and recording authorities |
| `source-engineering` | TypeScript AST edits, source-policy validation, compiler evidence, and semantic previews |
| `task-worktree` | Task-scoped Git isolation, sandboxed validation, diff ceilings, and approved commit synthesis |
| `usage-analyzer` | Read-only rollout discovery, aggregate reporting, and evidence-driven routing experiments |
| `verification-gate` | Mutation, property, modified-coverage, original-test, and independent-review acceptance |
| `workspace-transaction` | Recoverable, lease-serialized publication of approved workspace file sets |
| `workspace-policy` | Package, dependency, export, lockfile, and source-ownership enforcement |

See [workspace architecture](docs/workspace-architecture.md) for package and
generated-artifact boundaries. Prompt maintainers must also read the
[prompt-layer architecture](packages/prompt-layer/docs/architecture.md).

## Installation surfaces

### Plugin

Released plugins are installed through the Codex plugin/marketplace flow. The
generated plugin contains bundled executable entrypoints and portable assets;
it does not require this source workspace or its `node_modules`.

### Individual skills

Install selected public skills without activating the complete harness:

```sh
bunx skills add https://github.com/xsyetopz/skizzles --skill install-skizzles
```

See [`install-skizzles`](skills/install-skizzles/SKILL.md) for explicit install,
configuration, prompt-policy, and removal commands. Skill-only installation
does not activate hooks, change Codex configuration, or wire host services.
The optional `configure --instructions skizzles --source-root ...` mode installs
the portable root prompt and native role configuration; `native` remains the
default and leaves model instructions untouched.

### Install, configure, and remove

Use the installer when you want an explicit, receipt-owned setup. Always use
absolute `HOME`/`CODEX_HOME` paths, preview with `--dry-run`, review the target
and key list, then repeat the same command without `--dry-run`.

Install only the public skills when you want guidance without hooks or runtime
helpers:

```sh
bun run packages/installer/src/cli.ts install \
  --source-root /absolute/path/to/skizzles \
  --codex-home /absolute/target/codex-home \
  --surface skills --transfer link --dry-run
```

Choose `--transfer link` for a trusted checkout that should update in place, or
`--transfer copy` for an isolated snapshot. Install the complete development
harness only when you also want the bundled hook, runtime tools, and marketplace
entry:

```sh
bun run packages/installer/src/cli.ts install \
  --source-root /absolute/path/to/skizzles \
  --home /absolute/target/home \
  --surface harness --transfer copy --dry-run
```

Configuration is a separate step because it changes the selected Codex config,
not the installed files. Run it after the complete harness is installed and its
hook is available. `passive` enables hooks while preserving Codex's native
MultiAgentV2 defaults; `aggressive` additionally enables proactive Fourth Wall
routing and its bounded concurrency setting:

```sh
bun run packages/installer/src/cli.ts configure \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex \
  --orchestration passive --dry-run
```

The default `--instructions native` leaves model instructions and native role
configuration alone. To opt into Skizzles' portable root prompt and default,
Triage, Worker, Designer, QA, Review, and Deployment roles, add:

```sh
bun run packages/installer/src/cli.ts configure \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex \
  --orchestration aggressive \
  --instructions skizzles \
  --source-root /absolute/path/to/skizzles --dry-run
```

Preview removal before changing anything. Uninstall only removes paths and
marketplace state recorded by Skizzles receipts; it refuses foreign or drifted
targets rather than overwriting user changes:

```sh
bun run packages/installer/src/cli.ts doctor \
  --home /absolute/target/home \
  --codex-home /absolute/target/codex-home
bun run packages/installer/src/cli.ts unconfigure \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex --dry-run
bun run packages/installer/src/cli.ts uninstall \
  --surface skills --codex-home /absolute/target/codex-home --dry-run
bun run packages/installer/src/cli.ts uninstall \
  --surface harness --home /absolute/target/home --dry-run
```

Repeat each reviewed command without `--dry-run` to apply it. `unconfigure`
restores the exact values captured in the private config receipt; it does not
touch prompt policy, approvals, permissions, MCP registrations, or unrelated
settings. Prompt-policy apply/restore is an independent opt-in lifecycle; see
[`install-skizzles`](skills/install-skizzles/SKILL.md) before using it. Start a
new Codex session after installation or configuration so the new skills and
instructions are discovered.

### Source development

```sh
git clone https://github.com/xsyetopz/skizzles.git
cd skizzles
bun install --frozen-lockfile
bun run verify
```

The sole dependency lock is the root `bun.lock`. Biome is intentionally not a
workspace dependency; format, lint, and check commands pin Biome 2.5.4 through
`bunx`.

## Operational boundaries

Ordinary development and installation do not modify a live Codex home,
installed plugin, `PATH`, launchd, or active Container Lab state. Host wiring
for the model catalog and Container Lab is optional, explicit, reversible, and
documented by the owning packages.

Prompt-policy apply/restore uses explicit roots, an absolute Codex binary,
validated artifacts, owner-only receipts, atomic writes, and a recoverable
identity-bound lock. Start a new Codex session after applying or restoring a
policy.

## Maintainer commands

```sh
bun run format          # write formatting with Biome 2.5.4
bun run lint            # lint the complete source/generated boundary
bun run workspace:check # manifests, dependencies, exports, locks, and ownership
bun run typecheck       # every workspace package
bun run test            # canonical package-local suites only
bun run packages:build  # every declared package build
bun run plugin:check    # deterministic generated-plugin parity
bun run verify          # complete aggregate gate
bun run security:check  # networked workflow and credential gate
```

Change canonical package inputs, run `bun run plugin:build`, and review the
generated diff. Never repair `plugins/skizzles/` directly.

`verify` does not acquire these security binaries and remains independent of
their GitHub release-host availability. CI and release acceptance additionally
run `security:check` exactly once. That command downloads
repository-pinned actionlint 1.7.12, ShellCheck 0.11.0, and Gitleaks 8.30.1 release
archives into an owner-only temporary directory, checks their SHA-256 digests and
reported versions, validates the current Actions workflow, and scans both the
working tree and complete Git history. Acquisition or GitHub availability failure
fails closed; no tool cache or raw credential report is retained.
