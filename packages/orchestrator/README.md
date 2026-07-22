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

## Engineering workflow

`createEngineeringWorkflow()` is the public effectful entrypoint. It composes
the authenticated `@skizzles/source-engineering` facade with the internal
causal publication workflow:

1. `describe()` takes the language from a host-owned validation profile and
   captures exact baselines, declaration digests, language-bound template
   schemas, and a single-use source context receipt through the matching
   registered source adapter;
2. `prepare()` accepts only bounded declaration-level AST operations and
   host-owned validation-profile identifiers. Whole candidate bytes, regex
   rewrites, commands, and working directories are not public input;
3. source editing, formatting, complete-set policy/compiler validation, and
   artifact production run as one batch. The orchestrator independently checks
   every receipt binding and caps each candidate artifact at 1.5 MB;
4. context reservations are authority-owned before every source, physical, and
   publication transition. A typed pause returns an opaque same-process,
   one-shot continuation bound to the request, repository, target baseline,
   source cursor, evidence, and budget epoch. `cancelContinuation()` atomically
   releases an abandoned target reservation;
5. optional physical-integration declarations are attested only by the injected
   authority. Pure source changes never invoke it; accepted receipts must prove
   matching loopback endpoints, a successful complete probe, and terminal lab
   cleanup; and
6. the review exposes digest-only engineering preview evidence. Candidate bytes
   remain internal and canonical publication stays unchanged until external
   approval. Source artifacts and the authentic task receipt are revalidated
   immediately before promotion.

Validation profiles bind the source language, formatter, ordinary command
profiles, and distinct negative-test command profiles. A declared negative test
is rejected unless a host-owned negative-test profile is present, and both the
configured profile identities and observed command audits are bound into
approval evidence.

The internal causal state control enforces these publication properties:

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

The internal causal workflow composes those state machines with the intentional
public APIs of `@skizzles/task-worktree` and
`@skizzles/workspace-transaction`:

1. reserve a clean target baseline and require complete bounded discovery;
2. capture exact publication baselines, then ask the authentic task-worktree
   authority to allocate an isolated Git branch and worktree from the captured
   repository identity and exact candidate bytes. Oversized diffs return an
   explicit split plan; unresolved dependencies return intervention diagnostics,
   and neither outcome creates approval state;
3. run only the task-worktree authority's host-admitted sandbox profiles. Bind
   its authentic candidate, declared-path, dependency, sandbox, diff, phase,
   and commit-message digests plus the exact executed profile IDs into the
   immutable approval diff;
4. leave the canonical destination unchanged while approval is pending, then
   revalidate target state, engineering evidence, and the same authentic task
   session before consuming the single-use promotion permit;
5. create exactly one permit-bound commit on the isolated task branch, verify
   its authentic receipt against the approved task receipt, and only then
   publish the approved bytes through the transaction package;
6. on uncertain publication, retain the exact transaction bindings, task session,
   and target lease behind a single-use recovery handle and call the transaction
   package's public recovery entrypoint; and
7. cancel still-owned approval state, close the exact task worktree, and release
   the target lease in reverse acquisition order. Cleanup is single-flight;
   retries revisit only the failed cleanup stage.

Sandbox rejection, candidate drift, incomplete discovery, approval drift or
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

## Academic paradigm routing

`createAgentRuntime()` composes the Phase 7 capabilities and an authentic
Engineering workflow behind one branded facade. A run reads an immutable
`@skizzles/reflexion-memory` snapshot, obtains source-owned AST and contract
context from Engineering, reads specifications from a branded immutable
configuration authority, duplicates every protected fragment at both payload
boundaries, optionally applies deterministic auditable compression, and only
then invokes the injected model-dispatch authority. Dispatch requests are
runtime-authentic, digest-bound values; copied request shapes cannot invoke the
registered model adapter. Successful execution must traverse Engineering's
source, assurance, security, physical, task-worktree, mutation, property,
coverage, original-test, verification-gate, and approval preparation before the
runtime returns `awaiting-approval`.

The default route is the non-ReAct Locate, Patch, Verify state machine. The
model may select only one of four versioned command schemas from a branded host
catalog; it cannot provide a shell string, executable, environment, or loop
counter. Every catalog adapter result is a validated CodeAct sandbox request,
and only the branded CodeAct executor may produce the bounded immutable stdout,
stderr, byte counts, exit code, and observation digest. ReAct is absent unless
configured explicitly, and its step ledger is a private host-owned capability.

The dependency scheduler validates an immutable DAG, dispatches deterministic
ready waves up to the host parallelism limit, and serializes overlapping
repository or ancestor/descendant path claims. Failed and cancelled work blocks
its descendants while independent branches may finish. Scheduler receipts are
single-runtime authentic and execution IDs cannot be replayed.

Terminal failures are recorded only after execution through the separate
write-only Reflexion recorder. The active task cannot observe a record with its
own task or run identity; a later task may receive it as supporting context with
read-only external skill-directory references. Recording failure never changes
the already-established execution outcome. Model transport, credentials, and
endpoint selection remain injected host concerns.

Hosts that run comparable routing experiments may provide a validated
`routingAssignment` on each run. The assignment binds its candidate set,
propensity/seed, model, reasoning effort, decomposition, topology, role plan,
context strategy, and policy revision into every model-dispatch digest. An
optional `createRoutingExperimentObserver()` authority receives one
pre-approval, digest-only event with context estimates, all dispatch digests,
execution and engineering evidence, and the failure/awaiting-approval outcome.
Independent post-approval verification remains host-owned; observer failures
are reported in the receipt and cannot change execution or approval. The
runtime does not choose a candidate or own the experiment store.

## Development

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
