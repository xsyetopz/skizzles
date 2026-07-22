# ADR 0010: Modular orchestration runtime

- Status: Accepted
- Date: 2026-07-22

## Context

Skizzles needs a deterministic layer above Codex CLI that rejects repository
invariant violations before execution, preserves user intent without lossy tone
rewrites, binds decisions to evidence, and requires review before structural
mutation. Existing packages already own process supervision, disposable
workspaces, repository validation, isolated integration environments, prompt
provenance, and plugin staging. None owns the runtime policy that composes those
capabilities.

Putting policy in the repository root would make the root an ambient production
package. Putting it in `plugin-packaging` would mix runtime behavior with generated
distribution composition. Splitting the first phase across request, context,
tool, and validation packages would create package boundaries before independent
dependency or lifecycle evidence exists.

Several literal mechanisms proposed for this layer are unsafe substitutes for
their intended controls. Passing tests cannot justify immutable source files;
all stderr is not failure; automatic per-file commits break transactional and
phase-level review; hostile diagnostics are less auditable than stable factual
errors; destructive context or history wiping conflicts with recovery and
evidence retention.

## Decision

Create one private `@skizzles/orchestrator` Bun/TypeScript package as a modular
monolith. Internal modules own cohesive request, context, artifact, diagnostic,
checkpoint, and structural-review contracts. The package exposes one explicit
facade and admits external effects only through narrow injected ports.

Phase 1 uses these controls:

- effect classification belongs to a trusted injected authority whose result is
  bound to the exact normalized request and captured repository context; the
  orchestrator validates that binding and never infers effects from free-form
  wording;
- invariant preflight resolves to accept, reject, or approval-required before an
  authority-classified non-effect spawn port can run;
- intent normalization retains exact raw bytes and protected semantic fields;
- complete caller-validated artifacts remain separate from bounded presentation;
- repository anchors and tradeoffs are identity- and evidence-bound;
- checkpoints require compiler, test, verifier, and tree evidence, with explicit
  evidence-backed supersession instead of file locks;
- diagnostics retain original evidence and reject abusive or forged summaries;
- structural proposals bind immutable content references and pass adversarial
  security, performance, and maintenance review before application.

Later phases remain internal modules until dependency direction, public consumers,
or distinct lifecycle requirements justify extraction. Existing capability packages
remain authoritative; the orchestrator must not duplicate their implementations.
The plugin builder remains the sole generated distribution owner.

## Consequences

- Runtime policy has one accountable package and test boundary.
- Trust decisions are deterministic and reject forged or mutated evidence.
- Safe equivalents preserve the requested control without deadlocking valid repair,
  hiding tool semantics, or producing abusive output.
- The package is initially a canonical workspace surface, not a shipped plugin
  runtime. Distribution wiring occurs only with an executable entrypoint and its
  runtime proof.
- Extraction is evidence-driven rather than a package-per-pattern exercise.

## Rejected alternatives

- Extend `plugin-packaging`: rejected because staging and runtime policy have different
  reasons to change and would create dependency-cycle pressure when the runtime is
  distributed.
- Add root scripts: rejected because the root coordinates package owners and must not
  become an undeclared production domain.
- Create five policy/runtime packages immediately: rejected because the Phase 1
  domains share one lifecycle and dependency set; separate manifests would be
  ceremonial.
- Implement immutable files, stderr-is-fatal, hostile diagnostics, or per-file Git
  commits: rejected because they weaken correctness, recovery, and auditability.

## Fitness checks

```sh
bun run --cwd packages/orchestrator check
bun run --cwd packages/orchestrator typecheck
bun run --cwd packages/orchestrator test
bun run --cwd packages/orchestrator build
bun run workspace:check
bun run verify
```

Negative tests must prove zero spawn/application calls after policy rejection,
runtime-shape rejection, immutable evidence snapshots, checkpoint drift and
supersession behavior, artifact and diagnostic branding, anchor identity, and
structural-review bypass prevention.

## Review triggers

Review this decision when orchestration modules acquire distinct dependencies or
lifecycle, when the runtime becomes a distributed plugin surface, when Codex exposes
a stronger native policy boundary, or when an injected port can be replaced by a
compiler- or OS-enforced capability.
