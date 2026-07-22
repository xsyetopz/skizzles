---
name: completion-contract
description: Convert user intent, approved plans, and subagent handoffs into explicit completion contracts. Use when Codex is planning implementation, spawning subagents, setting or refining a /goal, defining acceptance criteria, avoiding scope shrink, deciding fan-out boundaries, or reviewing whether a claimed result satisfies the requested outcome.
---

# Completion Contract

Use this skill when an agent must translate user intent into implementation, delegation, or acceptance obligations. It is for planners, roots, workers preparing handoffs, and reviewers deciding whether a completion claim covers the requested outcome.

A completion contract states the smallest observable conditions that must be true before the work is done. It is not a plan, estimate, suggestion list, reduced first slice, or reason to stop early.

## Authority order

Resolve requirements in this order:

1. permanent user or repository instructions
2. explicit user non-negotiables
3. user-approved plan
4. task-specific outcome
5. agent implementation preference

A worker plan, convenient implementation, or smaller slice cannot weaken a higher-authority item. Escalate a genuine contradiction instead of choosing the easier requirement.

## Draft the contract

Normalize the task before delegation and again before claiming completion:

```text
Outcome:
Approved implementation path:
Non-negotiable constraints:
Disallowed alternatives:
Legacy/removal expectations:
Regression expectations:
Evidence expected:
Known valid blockers:
Unknowns requiring clarification:
```

Ask the user or parent orchestrator when an unknown would materially change one of these fields. Do not silently narrow the scope.

## Write observable obligations

Give each requirement one main obligation. Prefer verbs that describe an inspectable final state:

- implement
- remove
- replace
- wire
- preserve
- prove
- validate
- update
- delete
- migrate
- enforce
- route
- render
- persist
- reject
- fail

Replace soft qualifiers with exact obligations. Treat these phrases as warning signs:

```text
if possible
where possible
try to
attempt to
best effort
if too large
if time allows
fallback
temporary
for now
MVP
first slice
partial
stub
mock
document a workaround
leave the old path
keep both paths
manual step
remove or hard-disable
compatibility entrypoint
tombstone
legacy wrapper
```

The replacement must describe what users, callers, files, or runtimes will observe when the work is complete.

## Delegate without shrinking scope

Split a large outcome by responsibility before execution. Suitable ownership boundaries include API contracts, persistence, backend implementation, frontend integration, design polish, QA, and deployment or infrastructure.

Do not create packages named or scoped as:

- first slice
- make a start
- easiest part
- best effort
- docs-only substitute

Each delegated package must own its complete boundary and map to at least one top-level obligation. Its evidence should prove that boundary instead of returning unfinished work for the root to interpret.

## Valid blockers

A blocker must be concrete and external to ordinary implementation work:

- missing permissions
- unavailable external services
- missing required secrets
- inaccessible required files
- contradictory instructions
- unsafe work
- an explicit user decision that has not been made

Task size, difficult code, uncertainty, refactor effort, stale failing tests, or the absence of a convenient route are not blockers.

## Acceptance audit

Before execution and final acceptance, answer:

- Does the contract preserve the approved outcome?
- Did any package reduce the task to partial work?
- Did the implementation add fallback or compatibility paths that were not requested?
- Are legacy names, wrappers, disabled entrypoints, or tombstones still present against the removal contract?
- Can a reviewer inspect the required evidence?
- Does the contract allow fake UI, fake data, disabled checks, skipped tests, or manual workarounds?
- Were relevant skills, repository instructions, and role constraints preserved?

The final claim must cite concrete evidence such as changed files, commands, tests, screenshots, runtime artifacts, source inspection, or an exact blocker. A summary without inspectable evidence is not acceptance.

## Forward-progress checkpoints

Treat commits as validated repository checkpoints, independent of `/goal` lifecycle. A goal tracks the full outcome. A commit records one coherent causal state. Do not create or require a goal only to establish commit boundaries.

Commit after a coherent ownership slice is integrated, its focused proof passes, and that slice has no known breakage. Prefer a checkpoint before switching causal surfaces, starting a risky refactor, transferring substantial ownership, or beginning independent QA or Review. Keep unrelated slices separate, and describe the behavioral outcome in the commit message.

The root inspects shared-worktree ownership before committing. It excludes unrelated user or agent changes and does not commit every child completion automatically. Do not checkpoint known-broken intermediate states to reduce diff size. Keep reviewer corrections in later commits when practical so accepted history remains inspectable. Final acceptance covers the aggregate commit series and working tree, not only the latest checkpoint.

## Versioned acceptance contract

The published [acceptance schema](contracts/acceptance.schema.json) defines the portable v3 record. It includes requirement IDs, objective-gate results, an explicit objective-gates-before-judge order, artifacts, evidence/effect bindings, integrity findings, fixed retries and seeds, policy/model/validator identity, fixed judge version and prompt digest, and author/reviewer fields.

JSON Schema validates record shape. It does not prove an effect, compare identities, relate arbitrary references, or determine whether an implementation could inspect its verifier. The repository's strict typed evaluator consumes trusted harness facts plus explicit expected versions and digests.

The evaluator binds acceptance records to the expected objective and acceptance identity. Runtime effects pass only when their observation and evidence identity match independent harness facts. Test results must bind a known test-suite artifact. The acceptance digest is recomputed from the complete canonical record with only its self-referential digest zeroed. Any rewrite of scope, obligation, check, proof kind, evidence reference, artifact, effect, actor, judge, finding, or run therefore requires a new trusted digest.

The evaluator rejects duplicate or unknown requirements, non-contiguous gates, self-review, ineligible or unexpected reviewer identity, mutated verifier or test artifacts, untrusted, extra, or missing test results, unbound or non-causal gate evidence, fake effects, retry overflow, and judge-before-gate execution. Independent harness finding labels map to stable policy rejection codes for solution leakage, grader injection, hard-coded answers, and deceptive completion. The evaluator does not discover those conditions from arbitrary prose or source files.

The public [acceptance incident-regression corpus](fixtures/acceptance-incidents.json) contains a valid control, executable mutations, and stable rejection codes. It is implementation-visible regression input. It is not private or independent acceptance material.

These contracts have explicit limits:

- The schema and evaluator do not intercept native Codex handoffs.
- They cannot attest that host-supplied facts are truthful.
- They do not independently discover adversarial findings.
- They do not enforce host lifecycle.
- Verifier-resistant detection requires acceptance and review contexts that are independent of the implementation under evaluation.

A trusted integration must collect the facts and invoke the deterministic evaluator.

Reviewer eligibility is an exact local allowlist supplied by that integration, not a claim of global personhood or identity infrastructure. Run replay protection compares the submitted run ID with trusted prior run IDs; persistence and synchronization of that set remain host obligations.

Handoffs bind the acceptance document's repository-local reference to the exact trusted reference. Matching version and digest bytes at another location do not satisfy this local composition contract.
