# `@skizzles/source-engineering`

Private language-neutral source transformation and validation capability.

The package derives candidates from authority-captured baseline source through
node-scoped AST operations. It never writes the canonical repository. Parser,
template, formatter, compiler, and policy evidence is bound into immutable
receipts consumed by `@skizzles/orchestrator`. Declared physical integration is
attested separately by the orchestrator through Container Lab.

Prepared artifacts expose separately authenticated baseline and candidate byte
readers. Each call returns a fresh copy, and verification binds both channels
to the target receipt. This lets downstream change assurance measure the exact
captured baseline without rereading a race-prone workspace pathname.

`createSourceEngineering` accepts only authentic adapters registered by
language identifier. `createTypeScriptAstLanguageAdapter` supplies the current
TypeScript 7 AST implementation for TypeScript, JavaScript, and TSX source;
each registration owns its formatter profiles, compiler authority, compiler
profile, and symbol-index authority. Requests route through the exact
registered adapter, path/language mismatches fail closed, and an unregistered
language returns `UNSUPPORTED_LANGUAGE`. There is no regex or raw-text fallback.
The local symbol index remains advisory; the adapter's authority-issued
compiler result is final.

Every edit operation carries a required positive `epoch`. Operations with the
same epoch across different targets are staged against one predecessor
snapshot and committed together only after one authoritative compiler run over
the complete sorted candidate overlay. Epochs are contiguous and ordered;
duplicate target-node operations, gaps, reordering, and partial overlays are
rejected. One terminal all-target formatter epoch is followed by the same
full-overlay compiler boundary.

Host configuration includes a required `structuralPolicy` with
`metricVersion: "cyclomatic-v1"`, `maxFunctionComplexity`,
`maxFunctionIncrease`, and `maxAggregateIncrease`. The prepared task receipt
contains an authenticated `structuralReceipt`: exact AST operation identities
and spans, complete modified executable-node and branch maps, versioned
per-function complexity, mutation-site descriptors, and a predecessor-bound
compiler receipt chain. It contains digests and structural metadata, never
candidate source bytes. Missing or ambiguous executable maps and complexity
limit evasion fail closed.

The package facade exposes the language-neutral high-level engine, the
authenticated adapter contract, and the authority factories needed to
configure installed adapters. Parser, editor, policy, and evidence-composition
internals are deliberately not public entrypoints.

`createLiteralRegistry` creates the single typed magic-value registry used by
the validation gate. Its dedicated `register` operation issues immutable,
digest-bound receipts and a source property for the configured registry module.
Policy-sensitive values are valid only inside that module's exported
`satisfies` object; consumers must reference the exported property. File-local
constants, copied registry methods, copied snapshots, and inline duplicates of
registered values do not satisfy the gate. Only typed syntax contexts such as
module specifiers, discriminant tags, diagnostics, structural zero/one values,
and collection `at(-1)` indexes are exempt.

`compareJsonSemantics(actual, expected)` is the preconfigured portable-data
comparison helper. It compares JSON-domain values without scalar coercion,
ignores record member order, preserves array order, and rejects cyclic,
accessor-backed, or non-JSON values rather than silently normalizing them. The
changed-node assertion policy blocks serialized object/array string assertions
while preserving exact scalar status, code, and diagnostic assertions.

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
