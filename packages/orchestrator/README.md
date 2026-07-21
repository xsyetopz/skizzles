# `@skizzles/orchestrator`

Private deterministic orchestration policy for Skizzles. The package is one
modular Bun/TypeScript owner with a single facade at `src/index.ts`.

## Trust model

`createOrchestrator()` registers repository, effect-classification, graph,
measurement, verification, non-effect spawn, structural-application,
artifact-validation, and optional diagnostic interception authorities once. Its
controller then enforces the complete request-to-output path:

1. parse an exact UTF-8 JSON request envelope and derive a branded normalized
   request;
2. capture repository bytes and anchors through the repository authority;
3. classify effect through the trusted authority and require its strict result
   to match the request intent/raw digests and captured repository/tree/context
   digests;
4. obtain an invariant snapshot from the graph authority using that same captured
   repository context, without recapturing it;
5. allow only authority-classified `none` requests through the spawn port, then
   parse its output through registered artifact validators, branded diagnostics,
   and internal presentation accounting;
6. capture checkpoint evidence through the verification authority; and
7. measure, review, bind, and revalidate structural payload bytes before the
   application port can run.

Effectful actions never enter the registered `nonEffectSpawn` port. It is a
trusted read-only capability whose input is explicitly marked `effect: "none"`.
The controller does not infer effects from action names or wording. The trusted
effect-classification authority receives the exact branded normalized request
and captured repository context. Its output is exact-keyed, bounded, and bound
to the request and repository digests; malformed, unknown, drifted, or failed
classifications stop before graph inspection or spawn. A `structural`
classification requires the structural review path. Structural changes use
`proposeChange()`, `reviewChange()`, and `applyChange()`; application refreshes
the authority measurements and consumes the reviewed change exactly once. Any
failed or uncertain application attempt requires a fresh review before retry.
Checkpoint creation and supersession reserve their identifiers across authority
awaits and revalidate ledger state before committing a transition.

Every public runtime method accepts `unknown` and returns a typed accepted or
rejected result. Runtime-shape errors, authority failures, and port exceptions
fail closed. Digest constructors and internal brands are not public.

Request envelopes contain exactly these fields: `version`, `action`, `subject`,
`descriptors`, `negations`, `identifiers`, `quotedText`, `scope`,
`securitySeverity`, and `userCopy`. Duplicate and unknown JSON fields are
rejected. Only the framework-owned redundant-style descriptor lexicon is
removed from the canonical semantic descriptor set; the exact source and raw
bytes remain recoverable.

## Development

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
