# ADR 0001: Use a modular packaging monolith

- **Status:** Accepted
- **Date:** 2026-07-18
- **Decision owner:** repository architecture
- **Scope:** workspace packages, composition roots, canonical inputs, and plugin distribution

## Context

Skizzles is one Bun/TypeScript workspace that builds one deterministic Codex plugin.
The observed baseline has nine capability packages, one root `bun.lock`, and one
declared internal package dependency: `@skizzles/plugin-builder` depends on
`@skizzles/prompt-layer`. The root orchestrates package-owned commands; it is not a
runtime package. `plugins/skizzles/` is generated distribution output.

The architecturally significant requirement is to preserve those delivery contracts
while making ownership, dependency direction, and change reasons explicit. The
baseline structural audit reported 19 errors, 12 warnings, and 20 notices, including
oversized canonical owners and a hidden installer-to-Container-Lab filesystem edge.
Those findings are migration inputs, not evidence that a different deployment model
is required.

Evidence and applicability decisions are recorded in the
[research ledger](../research/architectural-cohesion-ledger.md). Fowler's evolutionary
architecture guidance supports feedback-driven change; the pattern catalogs are
discovery aids rather than prescriptions.

## Decision

Skizzles remains a **modular packaging monolith**:

1. The repository is one governed workspace and one dependency-resolution domain.
2. A package represents a durable capability with its own manifest, source, tests,
   documentation, intentional exports or binaries, and local verification path.
3. Package internals are organized by feature or pipeline stage, not by universal
   `services`, `helpers`, `common`, or `core` layers.
4. Cross-package TypeScript dependencies use a direct `workspace:*` manifest edge and
   the provider's public export. Private-path and cross-package relative imports are
   forbidden.
5. Prompt production, plugin staging, and state/synchronization behavior are explicit
   pipelines. A stage owns its input validation, output contract, and failure behavior.
6. `packages/plugin-builder/` is the only plugin staging composition root.
   `packages/prompt-layer/` owns prompt inputs and provenance. Canonical packages and
   `skills/` point toward `plugins/skizzles/`; generated output never points back or
   becomes source authority.
7. A port is introduced only when an unstable external actor needs replacement or a
   deterministic fake: host filesystems, processes, clocks, networks, Docker/Compose,
   or vendor/model APIs. The policy owner defines the port; the entrypoint composes the
   adapter.
8. Entry points parse inputs, construct adapters, delegate, report deterministic
   results, and own lifecycle cleanup. They do not accumulate domain policy.

The installer-to-Container-Lab descriptor requirement is realized by the declared
`@skizzles/installer -> @skizzles/container-lab` dependency and Container Lab's public
`./integration-descriptor` export (integrated in commit `9e24b21`). This resolves that
specific baseline coupling; it does not establish that the remaining campaign fitness
checks pass. A relative filesystem reach into another package is not an accepted
boundary.

## Considered alternatives

- **Microservices:** rejected. There is no independent deployability, scaling, data
  ownership, regulatory boundary, or network-failure requirement to justify them.
- **Universal clean/layered architecture:** rejected. Repeating controllers, services,
  repositories, and interfaces in every package would add navigation and forwarding
  cost without enforcing a real replacement boundary.
- **Dependency-injection container:** rejected. Explicit TypeScript composition roots
  are inspectable and sufficient; a registry would obscure ownership and cycles.
- **Single root package:** rejected. Existing capability packages provide real
  manifest, test, and public-surface boundaries.
- **Package per file or pattern:** rejected. File size and parallel work do not justify
  a dependency boundary.
- **Generated plugin as canonical source:** rejected. It creates two authorities and
  makes deterministic regeneration unverifiable.

## Consequences

- Package movement requires atomic manifest, export, test, build, and generated-output
  updates.
- Some local duplication is preferable to an ownerless shared abstraction.
- Ports and interfaces remain uncommon and evidence-driven.
- Existing oversized files require cohesive extraction inside their current capability
  before any new package is considered.
- Plugin compatibility is preserved through canonical-to-generated parity, not aliases
  or permanent migration shims.

## Fitness checks

Required confirmation checks are:

```sh
bun run workspace:check
bun run packages:check
bun run typecheck
bun run test
bun run packages:build
bun run plugin:check
python3 "${ARCHITECTURAL_COHESION_SKILL}/scripts/audit_structure.py" .
```

Here `ARCHITECTURAL_COHESION_SKILL` is the resolved skill directory supplied by the
active engineering environment; it is not a repository dependency.

Architecture checks must additionally prove cycle freedom, direct manifest
dependencies, no private/cross-package relative imports, no production-to-test or
generated-source dependency, intentional export budgets, thin composition roots, and
canonical/generated direction. A build alone is insufficient proof.

At campaign start, a frozen install and `bun run verify` passed 467 tests at commit
`3ae68feb0227c33f9e449664743951e4413ed7a5`; the structural audit still had the
findings above. This is baseline evidence, not final acceptance.

## Review and supersession

Review this decision if Skizzles gains a separately operated deployable, independent
data ownership, an externally versioned runtime protocol, or evidence that a package
cannot be verified without unrelated workspace state. Supersede this ADR before
introducing a service boundary or a second dependency-resolution domain.
