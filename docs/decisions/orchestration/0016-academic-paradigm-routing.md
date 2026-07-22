# ADR 0016: Academic paradigm routing

- Status: Accepted
- Date: 2026-07-22

## Context

The orchestration workflow already owns request normalization, source edits,
assurance, isolated task execution, verification, approval, and publication. It
does not define how an agent selects an execution paradigm, how concurrent work
is dependency-gated, how terminal commands are exposed, or how outbound context
and prior failure knowledge are constructed. Leaving those choices to a model
would reintroduce self-controlled loops, generic shell access, conflicting
workers, mutable self-memory, and prompt payloads that can bury or compress away
their governing contracts.

The named research paradigms are design inputs, not dependencies or claims of
paper-exact reproduction. Their useful constraints must be translated into
typed, locally enforceable capabilities with deterministic evidence.

## Decision

The orchestrator owns one academic-paradigm routing boundary. Agentless is the
default execution state machine and advances exactly through Locate, Patch, and
Verify. ReAct is an explicit alternate route whose step ledger and fixed budget
are owned by the host; observations and agent output cannot mutate the loop
counter or choose another iteration.

Terminal access is a closed catalog of small versioned command schemas. Catalog
entries resolve only through authenticated command executors and never accept a
generic shell string. Every invocation crosses a structured process sandbox and
returns bounded immutable stdout, stderr, and exit-code metadata.

A dependency scheduler validates an immutable acyclic graph, admits only ready
nodes, and dispatches a bounded number of non-conflicting workers. Repository
and ancestor-or-descendant path claims serialize overlapping writes. Failure or
cancellation blocks unsafe descendants and remains visible in the final ledger.

Outbound context construction ranks protected AST, specification, and contract
fragments and places authenticated copies at both context boundaries. Optional
compression is disabled by default, records every keep or reduction decision,
and preserves protected fragments byte-for-byte. The resulting payload and
audit receipt are produced before an injected model-dispatch capability can run;
the repository runtime does not embed a live OpenAI endpoint.

`@skizzles/reflexion-memory` owns structured cross-task failure knowledge. A
reader receives immutable snapshots from an injected store or explicit local
SQLite database and excludes records written by the consuming task. A separate
recorder appends failures only after execution. Skill-directory references are
data, not executable imports. The active run never reads its own critique,
mutates stored memory, selects an ambient database path, or controls retention.

## Rejected alternatives

- A generic agent loop with a prompt-stated budget: the model could extend or
  reset its own iteration state.
- Generic shell passthrough behind a schema field: the field would remain an
  ambient command-execution capability.
- Optimistic concurrent writes followed by merge repair: conflict prevention is
  cheaper and preserves causal evidence.
- In-prompt self-critique or mutable current-task memory: it creates recursive
  prompt drift and lets the active agent rewrite its own evidence.
- Opaque lossy compression: acceptance cannot depend on context transformations
  that a reviewer cannot reconstruct.
- A repository-owned live model client: endpoint credentials, transport policy,
  and model selection belong to the host adapter.

## Consequences

- Hosts provide narrow execution, worker, persistence, and model-dispatch
  authorities; the framework retains policy and ordering.
- Agentless work is predictable by default. ReAct and compression require
  explicit configuration and remain bounded.
- Parallelism is reduced when repository path claims overlap.
- Reflexion memory helps later tasks only; it intentionally cannot affect the
  task that records a failure.
- Compression is auditable but cannot guarantee the behavior of an external
  language model.

## Confirmation

- Execution tests prove Agentless ordering, host-owned ReAct exhaustion,
  command-catalog isolation, structured sandbox metadata, and lookalike
  rejection.
- Scheduler tests prove DAG validation, bounded concurrency, deterministic ready
  order, path-conflict serialization, descendant blocking, and cancellation.
- Context tests prove boundary placement, protected-byte preservation,
  deterministic audit receipts, and disabled-by-default compression.
- Reflexion-memory tests prove immutable snapshots, separate recorder authority,
  current-task exclusion, persistence binding, and hostile-input rejection.
- Router tests prove the complete causal order around model dispatch and failure
  recording.
- Workspace checks, typechecks, package tests and builds, architectural audit,
  and plugin parity remain release gates.

## Review triggers

- Execution moves across processes or machines.
- A command schema, path-conflict model, or scheduler retry policy changes.
- Compression becomes model-based or non-deterministic.
- Memory retention, privacy, or current-task visibility semantics change.
- The repository begins owning a live model endpoint.
