# Architecture decision log

This directory records consequential Skizzles architecture decisions. Each record
owns one decision, its evidence, rejected alternatives, consequences, fitness
checks, and review triggers. A record is historical evidence: replace a decision
by adding a new record and marking the old record superseded rather than silently
rewriting its rationale.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](workspace/0001-modular-packaging-monolith.md) | Accepted | Use a capability-package modular monolith with explicit build pipelines and a generated plugin boundary. |
| [0002](workspace/0002-executable-architecture-fitness.md) | Accepted | Enforce ownership and dependency rules with executable fitness checks and bounded exceptions. |
| [0003](orchestration/0003-agent-trust-and-evaluation.md) | Accepted | Keep agent judgment bounded by typed trust context, capability controls, and independent evaluation. |
| [0004](platform/0004-measurement-gated-rust.md) | Accepted | Admit Rust only through a measured, reversible parity gate. |
| [0005](workspace/0005-ephemeral-repository-security-tools.md) | Accepted | Verify Actions and credential hygiene with ephemeral checksum-pinned tools. |
| [0006](platform/0006-container-process-environment.md) | Accepted | Isolate Docker Compose and local Git process environments behind explicit capabilities. |
| [0007](workspace/0007-repository-identity.md) | Accepted | Bind durable source identity to the common Git filesystem object and dissociate clone object stores. |
| [0008](workspace/0008-typescript-source-parser.md) | Accepted | Parse static TypeScript dependency forms with one lifecycle-bounded compiler AST snapshot. |
| [0009](workspace/0009-owned-scratchspaces.md) | Accepted | Own disposable run roots, child shutdown, preservation, signals, and stale cleanup in one capability package. |
| [0010](orchestration/0010-orchestration-runtime.md) | Accepted | Own deterministic orchestration policy in one modular runtime package with fail-closed trust boundaries. |
| [0011](orchestration/0011-orchestration-execution-boundaries.md) | Superseded by 0014 | Retain the durable publication boundary; replace orchestrator-owned copy staging and command execution with authenticated task worktrees. |
| [0012](workspace/0012-source-transformation-pipeline.md) | Accepted | Derive candidate bytes through a TypeScript-first source-transformation capability and bind validation provenance into the gated publication path. |
| [0013](workspace/0013-change-assurance-boundary.md) | Accepted | Assess exact source candidates through independently owned security, migration, performance, and supply-chain authorities before integration or approval. |
| [0014](workspace/0014-task-worktree-boundary.md) | Accepted | Isolate each task in an authenticated Git worktree with exact write scope, sandboxed commands, bounded diffs, and one approved commit. |
| [0015](workspace/0015-acceptance.md) | Accepted | Gate publication on exact mutation, property, modified-coverage, original-test, security-review, specification-lock, and task-context-reset evidence. |
| [0016](orchestration/0016-academic-paradigm-routing.md) | Accepted | Compose bounded academic agent paradigms through one host-owned execution and context-routing boundary. |
| [0017](orchestration/0017-evidence-driven-routing.md) | Accepted | Learn routing from digest-bound, independently verified workflow evidence; keep assignment and endpoints host-owned. |

## Record contract

A new or superseding ADR must include:

- the context and architecturally significant requirement;
- direct evidence and material uncertainty;
- considered alternatives and the selected outcome;
- positive and negative consequences;
- executable confirmation checks, or a named gap and delivery owner;
- review triggers and supersession links.

Implementation status belongs in source, tests, and command output. An accepted ADR
does not claim that every listed fitness check is already implemented or passing.
