# Architecture decision log

This directory records consequential Skizzles architecture decisions. Each record
owns one decision, its evidence, rejected alternatives, consequences, fitness
checks, and review triggers. A record is historical evidence: replace a decision
by adding a new record and marking the old record superseded rather than silently
rewriting its rationale.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-modular-packaging-monolith.md) | Accepted | Use a capability-package modular monolith with explicit build pipelines and a generated plugin boundary. |
| [0002](0002-executable-architecture-fitness.md) | Accepted | Enforce ownership and dependency rules with executable fitness checks and bounded exceptions. |
| [0003](0003-agent-trust-and-evaluation.md) | Accepted | Keep agent judgment bounded by typed trust context, capability controls, and independent evaluation. |
| [0004](0004-measurement-gated-rust.md) | Accepted | Admit Rust only through a measured, reversible parity gate. |
| [0005](0005-ephemeral-repository-security-tools.md) | Accepted | Verify Actions and credential hygiene with ephemeral checksum-pinned tools. |
| [0006](0006-container-process-environment.md) | Accepted | Isolate Docker Compose and local Git process environments behind explicit capabilities. |

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
