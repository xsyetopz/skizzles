# `@skizzles/source-transformation`

This private package derives source candidates from authority-captured baseline
bytes through node-scoped AST operations. Orchestration hosts use it when they
need language-neutral transformation evidence without writing the canonical
repository.

## Public facade

The package root exports `createSourceEngineering`, authenticated language
adapter contracts and factories, TypeScript adapter registration, evidence
guards, the magic-value registry, and `compareJsonSemantics`. Parser, editor,
policy, and evidence-composition internals remain private.

`createSourceEngineering` accepts only authentic adapters registered by
language identifier. `createTypeScriptAstLanguageAdapter` is the current
TypeScript 7 AST implementation for TypeScript, JavaScript, and TSX. Each
registration owns its formatter profiles, compiler authority and profile, and
symbol-index authority. A path/language mismatch fails closed, and an
unregistered language returns `UNSUPPORTED_LANGUAGE`. There is no regex or
raw-text fallback. The local symbol index is advisory; the authority-issued
compiler result is final.

Prepared artifacts expose separately authenticated baseline and candidate byte
readers. Each call returns a fresh copy, and verification binds both channels
to the target receipt. Downstream change assurance can therefore measure the
captured baseline without rereading a workspace pathname.

## Transformation contract

Every edit operation has a positive `epoch`. Operations in the same epoch are
staged against one predecessor snapshot and commit together only after one
authoritative compiler run over the complete sorted candidate overlay. Epochs
must be contiguous and ordered. Duplicate target-node operations, gaps,
reordering, and partial overlays are rejected. One terminal all-target
formatter epoch is followed by the same full-overlay compiler boundary.

Host configuration must include `structuralPolicy` with
`metricVersion: "cyclomatic-v1"`, `maxFunctionComplexity`,
`maxFunctionIncrease`, and `maxAggregateIncrease`. The prepared task receipt
contains an authenticated `structuralReceipt` with exact AST operation
identities and spans, complete modified executable-node and branch maps,
versioned per-function complexity, mutation-site descriptors, and a
predecessor-bound compiler receipt chain. It contains digests and structural
metadata, never candidate source bytes. Missing or ambiguous executable maps
and complexity-limit evasion fail closed.

Parser, template, formatter, compiler, and policy evidence is bound into
immutable receipts consumed by
[`@skizzles/orchestrator`](../orchestrator/README.md). Declared physical
integration is attested separately by the orchestrator through
[`@skizzles/container-lab`](../container-lab/README.md).

## Supporting utilities

`createLiteralRegistry` creates the typed magic-value registry used by the
validation gate. Its `register` operation issues immutable digest-bound
receipts and a source property for the configured registry module.
Policy-sensitive values are valid only inside that module's exported
`satisfies` object; consumers must reference the exported property. File-local
constants, copied registry methods or snapshots, and inline duplicates do not
satisfy the gate. Only typed syntax contexts such as module specifiers,
discriminant tags, diagnostics, structural zero/one values, and collection
`at(-1)` indexes are exempt.

`compareJsonSemantics(actual, expected)` compares JSON-domain values without
scalar coercion. It ignores record-member order, preserves array order, and
rejects cyclic, accessor-backed, or non-JSON values. The changed-node assertion
policy blocks serialized object/array string assertions while preserving exact
scalar status, code, and diagnostic assertions.

Runtime dependencies are
[`@skizzles/candidate-manifest`](../candidate-manifest/README.md),
[`@skizzles/scratchspace`](../scratchspace/README.md), and TypeScript 7.0.2.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
