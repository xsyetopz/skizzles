# Skizzles

![Skizzles logo](packages/plugin-builder/template/assets/logo.png)

Skizzles is a portable Codex engineering harness distributed as a deterministic
plugin. Its canonical implementation is a Bun workspace of strict TypeScript
packages; `plugins/skizzles/` is generated output.

## Capabilities

- reusable Codex skills and native Fourth Wall orchestration guidance;
- a permission-neutral command hook and bounded command supervisor;
- privacy-preserving rollout usage analysis;
- disposable Docker Compose Container Lab tooling;
- a validated model-catalog overlay with explicit host activation;
- reversible Codex configuration and prompt-policy installers;
- checksum-locked derivation of the Codex base-instruction layer.

## Workspace

Production TypeScript is owned by packages under `packages/`. The FastMCP
project template is also an explicit workspace at
`skills/codex-project-tooling/assets/fastmcp-bun-template` so it cannot depend
on undeclared root packages.

| Package | Responsibility |
| --- | --- |
| `command-hook` | Hook event validation and command classification |
| `command-supervisor` | Bounded process execution, artifacts, retention, and queries |
| `container-lab` | Container Lab CLI, reaper, durable state, synchronization, and docs |
| `installer` | Skills/harness install, Codex configuration, doctor, and prompt-policy lifecycle |
| `model-catalog` | Isolated catalog refresh and LaunchAgent rendering |
| `orchestrator` | Deterministic request policy, evidence checkpoints, and structural review contracts |
| `plugin-builder` | Deterministic plugin staging, bundling, validation, and drift checks |
| `prompt-layer` | Pinned upstream prompt, patch derivation, provenance, and recovery |
| `usage-analyzer` | Read-only rollout discovery, aggregation, and reporting |
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
