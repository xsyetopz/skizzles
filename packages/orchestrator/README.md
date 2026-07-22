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

## Execution state

Phase 2 state control is exposed through the same fail-closed facade:

- declared relative targets are normalized and reserved before repository-state
  capture; unrelated dirty paths are allowed, while staged, unstaged, untracked,
  deleted, renamed, or conflicted declared targets reject the baseline;
- repository authority evidence binds the request, tree, target set, HEAD, index,
  worktree, and status digests, and promotion requires a fresh exact
  revalidation;
- risk-class execution budgets are fixed by the host and account for actions,
  retries, repeated causal failures, and wall-clock time. Exhausted or completed
  executions are sealed and cannot be restarted by caller input;
- completion requires every configured contract check to pass through the
  completion authority; one successful check cannot terminate a run;
- repository discovery applies host-owned roots, exclusions, depth, file, byte,
  and time bounds without following symlinks. Incomplete discovery is explicit
  and cannot authorize promotion. Expansion requires a separately bound review;
  and
- approval progresses through planned, reviewed, awaiting, approved, and
  promoting states. Its expiring single-use challenge binds the task,
  principal, operation, request, tree, target baseline, transaction, discovery,
  and immutable full-diff digests. Authentication and baseline revalidation are
  authority-owned and concurrent, replayed, cancelled, expired, or drifted
  attempts fail closed.

`createCausalWorkflow()` composes those state machines with the intentional
public APIs of `@skizzles/command-supervisor`, `@skizzles/run-workspace`, and
`@skizzles/workspace-transaction`. It is the Phase 2 effectful entrypoint:

1. reserve a clean target baseline and require complete bounded discovery;
2. start the host-owned execution budget, create an isolated run workspace, and
   check its byte, entry, and scan quotas before and after every operation;
3. snapshot bounded caller candidate bytes, materialize coordinator-named files
   in a fresh direct-child command directory with exclusive no-follow handles,
   and execute only host-registered, absolute direct-argv command profiles in
   that directory. Caller-selected working directories and candidate paths are
   not accepted;
4. require an allowed exit, complete stdout/stderr evidence, complete stream
   drain, confirmed process-tree cleanup, and unchanged regular single-link
   candidate identities and contents before binding the complete immutable diff
   to approval;
5. leave the canonical destination unchanged while approval is pending, then
   revalidate workspace quota, authorization expiry, and target state
   immediately before consuming the single-use promotion permit through the
   transaction package. Authorization is checked again after asynchronous
   target revalidation;
6. on uncertain publication, retain the exact transaction bindings, workspace,
   and target lease behind a single-use recovery handle and call the transaction
   package's public recovery entrypoint; and
7. cancel still-owned approval state, close the exact run workspace, and release
   the target lease in reverse acquisition order. Cleanup is single-flight;
   retries revisit only the failed cleanup stage.

Timeouts, signals, output overflow, incomplete drain, forced process-tree kill,
unknown or exceeded workspace usage, incomplete discovery, approval drift or
replay, transaction uncertainty, and cleanup failure cannot produce a completed
result. The transaction approval bridge is coordinator-owned, so callers cannot
construct a publication authority or replay a permit through the workflow.
Failed prepare attempts terminate their active execution session exactly once,
releasing request deduplication while retaining cumulative action, retry,
causal-failure, and wall-clock consumption. A transaction result that proves
publication committed but reports non-recoverable lease cleanup failure is
returned as committed truth and is never routed through journal recovery.

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
