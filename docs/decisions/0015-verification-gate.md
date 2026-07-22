# ADR 0015: Verification gate and task-context reset

- Status: Accepted
- Date: 2026-07-22

## Context

The existing workflow proved source transformation, non-functional assurance,
physical integration, isolated task execution, approval, and publication. It did
not prove that tests killed every modified logical mutant, exercised every
modified executable node and branch, retained the original test and
specification corpus, or survived random and extreme inputs. It also retained
task-scoped capabilities across interrupts without a complete epoch transition.

Treating command success as verification would let a host omit objectives,
weaken tests, forge summary artifacts, or approve its own evidence. Clearing
process-global model or host history is neither locally enforceable nor safe;
the framework can authoritatively invalidate only the task state and
capabilities it owns.

## Decision

Create `@skizzles/verification-gate` as the sole Phase 6 acceptance aggregator.
It receives distinct branded authorities for source structure, mutation,
property/fuzz, modified coverage, original tests, exclusions, and independent
review. It derives the exact mutant inventory from authenticated source
evidence, requires a result for every objective, permits an invalid or
equivalent mutant only through an exact independent exclusion, and rejects every
surviving or timed-out mutant. Property runs use a host-fixed deterministic seed
schedule; coverage binds every modified executable node and branch to configured
hit thresholds.

`@skizzles/task-worktree` remains the command and artifact owner. Test writes
require exact task authorization; specification roots are always read-only and
hashed before execution. Original tests run in a literal container-user
namespace against the baseline test manifest and candidate production overlay.
Every verification command receives a source-free, exact objective manifest,
and its safe kind-specific report is bound through sandbox, execution, artifact,
and verification receipts. Public receipts never contain source bytes,
arbitrary artifact values, callbacks, or executable commands.

`@skizzles/candidate-manifest` defines the explicit cross-domain candidate
identity. Source engineering, change assurance, and task-worktree each derive
the same versioned manifest from the exact file paths, operations, and content
digests they authentically own. Their native aggregate candidate digests remain
distinct; the orchestrator and verification gate compare the independently
authenticated manifest digests instead of equating unrelated hash domains.

`@skizzles/source-engineering` owns atomic generation epochs. It runs the full
compiler over the candidate overlay after every epoch and reports modified
functions, class initializers, module initializers, executable nodes, branches,
mutation sites, variants, and cyclomatic complexity. Unmapped executable changes
fail closed. `@skizzles/change-assurance` owns the security-policy linter and a
distinct independent security reviewer; every high or critical finding blocks,
with no suppression or waiver surface.

The orchestrator composes these capabilities in causal order: source epochs,
change assurance and security review, physical integration, task preparation,
four isolated verification profiles, verification-gate evaluation, final
evidence construction, publication approval, and promotion revalidation. A
pre-verification candidate cannot be published or approved.

Interrupt or rejection closes task admission, settles owned resources, restores
an authentic task-bound checkpoint, performs a fresh bounded discovery, and
creates a new task epoch. Old continuations, sessions, approvals, reviews, and
receipts remain invalid. Authority exceptions return bounded one-shot recovery
handles instead of stranding the reset. This is the enforceable interpretation
of a context flush: framework-owned state and capability epochs are replaced;
unowned model or host history is not claimed to be erased.

## Rejected alternatives

- Let each command report its own objective set: omitted mutants and branches
  would be indistinguishable from successful verification.
- Accept arbitrary JSON artifacts: benign field names could exfiltrate source,
  credentials, or host paths into durable receipts.
- Let the reviewer waive failed objective evidence: the reviewer would become a
  second mutable policy authority rather than an independent final check.
- Run original tests under a generic process sandbox: that does not prove a
  literal isolated validation container or the baseline test corpus.
- Clear unowned process or model history: the claim is unverifiable and risks
  destroying host state outside repository authority.

## Consequences

- Verification is causally downstream of exact source evidence and upstream of
  approval; there is no evidence-shaped shortcut.
- Hosts must provide real mutation, property, coverage, original-test container,
  exclusion, and independent-review authorities with exact bindings.
- Test rewrites are explicit task inputs, while specifications cannot be changed
  during an active task.
- Context reset is recoverable and race-safe, but intentionally limited to
  framework-owned state.

## Confirmation

- Source-engineering tests cover class fields, static blocks, module-level
  expressions, deterministic mutant variants, complexity limits, and compiler
  sequencing.
- Task-worktree tests cover protected paths, baseline/candidate manifests,
  specification locks, source-free objective reports, literal container proof,
  and forged artifact rejection.
- Change-assurance tests cover destructured and cross-file taint, dynamic Bun and
  global dispatch, secure-interface dominance, and independent-review halts.
- Verification-gate tests cover complete inventories, exclusions, deterministic
  fuzz schedules, threshold boundaries, reviewer ordering, receipt drift, and a
  real child-process mutant killed by a boundary case.
- Orchestrator tests cover causal ordering, finalization, promotion revalidation,
  task-epoch races, restoration authenticity, and recoverable reset failures.
- Aggregate workspace checks, builds, tests, architectural audit, and plugin
  parity remain release requirements.

## Review triggers

- A new source language requires a different executable or mutation model.
- A verification engine changes objective, coverage, or isolation semantics.
- Cross-process or durable task resumption replaces the same-process epoch
  ledger.
- The workflow gains distributed scheduling or remote publication.
