# ADR 0012: Add a source-transformation pipeline

Status: Accepted

## Context

Phase 3 must prevent raw text replacement, fabricated symbol knowledge,
format-only behavioral claims, happy-path-only validation, unfinished source,
and unbound toolchain evidence. These controls need compiler and source-policy
knowledge, but durable publication and approval remain separate capabilities.
The high-level workflow must remain independent of a parser's domain types,
while every installed language still needs an executable AST and compiler
boundary.

## Decision

- `@skizzles/source-transformation` owns immutable source captures, an authentic
  language-adapter registry, node-scoped edits, compiler-backed symbol evidence,
  changed-node policy checks, templates, formatter idempotence, semantic diff,
  and validation provenance. The public engine routes language-neutral requests
  without exposing parser-domain types. The TypeScript 7 AST adapter currently
  serves TypeScript, JavaScript, and TSX; unsupported languages reject without a
  raw-text fallback.
- `@skizzles/orchestrator` owns the public edit-to-preview state machine,
  host-issued context budgets and continuations, physical-integration evidence
  requirements, approval binding, and composition with Phase 2 publication.
- The Phase 2 raw-candidate coordinator becomes internal machinery. Public
  engineering input carries typed node operations and fault declarations, not
  complete candidate bytes, regex replacement programs, working directories,
  or arbitrary commands.
- A local symbol index is advisory and bound to the repository tree and compiler
  configuration. The compiler authority is final when index and compiler
  evidence disagree.
- Formatter, parser, template, ruleset, compiler, test, and declared physical
  integration evidence are provenance-bound to exact candidate and preview
  digests. Formatting must be byte-idempotent on a second pass and preserve the
  semantic tree.
- Physical integration environments are required only for declared external
  connection points. Unit doubles cannot mint physical receipts, while a pure
  source edit does not manufacture a container requirement.
- Budget exhaustion pauses before incomplete output. Continuations are
  same-process, single-use, authority-issued, and identity-bound; caller input
  cannot enlarge host limits or resume across tree or provenance drift.

## Rejected alternatives

- Extending the orchestrator into a compiler/editor/container monolith reverses
  capability ownership and makes later language adapters inseparable from run
  policy.
- Splitting one package per Phase 3 rule creates premature public seams before a
  second language proves an adapter boundary.
- Reusing workspace-governance as a runtime dependency is rejected because it owns
  repository tooling and an executable surface; the source-transformation package
  is the narrow reusable production capability.
- Loose deep equality, blanket string-assertion bans, whole-tree literal bans,
  and mandatory containers for pure code are rejected as unsound substitutes
  for objective-aware changed-node checks.

## Consequences

- Candidate bytes are derived, validated, and digest-bound before Phase 2 can
  preview or publish them.
- A new parser family requires an explicit parser/editor/symbol adapter and its
  own proof; registering a language identifier cannot fabricate capability.
- Toolchain drift, stale symbols, formatter instability, incomplete fault
  evidence, placeholder nodes, unsafe dynamic boundaries, and missing physical
  receipts stop before approval.
- Cross-process continuation durability remains out of scope until a durable
  checkpoint authority is introduced.

## Fitness checks

Phase 3 acceptance requires real TypeScript parser/compiler fixtures, hostile
input and node-drift tests, unsupported-language rejection, compiler-over-index
tests, changed-node policy positives and false-positive controls, formatter
semantic/idempotence tests, budget replay and drift tests, physical-receipt
fail-closed tests, a causal edit-to-publication integration, workspace
architecture checks, aggregate verification, and generated-plugin parity.
