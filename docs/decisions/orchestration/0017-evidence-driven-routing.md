# ADR 0017: Evidence-driven routing experiments

- Status: Accepted
- Date: 2026-07-22

## Context

Fourth Wall needs to optimize complete workflows rather than guess a model
winner from AAII scores or prices. Existing rollout analysis measures model and
effort token totals, but it cannot establish independently verified success,
assignment propensity, task strata, context duplication, retries, escalation,
replacement, per-stage roles, or a causal join to the orchestrator receipt.
The orchestrator must remain independent of live model endpoints and host
transport policy.

## Decision

The host owns candidate eligibility, assignment, transport, credentials, and
persistence. A routing assignment is an immutable, digest-bound record of the
candidate set, selected model and effort, workflow topology/decomposition,
role/context strategy, propensity or seed, safety floor, and policy revision.
The orchestrator accepts an optional assignment, binds it to every dispatch
request, and exposes an optional injected observer that records one
pre-approval, privacy-safe event. Observer failure is non-causal: it cannot
alter execution, approval, or failure recording. Receipts carry assignment and
observation digests plus observation status for joins; independent post-
approval verification remains host-owned.

`@skizzles/usage-analysis` owns strict in-memory routing evidence and learning.
It accepts candidate priors as metadata only, rejects raw prompt/path/title/
secret fields, accounts for model usage plus measured disjoint coordination
overhead,
stratifies by task and workflow shape, and recommends only candidates that clear
minimum-sample and independent-verification gates. The primary score is
expected total workflow tokens per verified success; cost and latency are
secondary. No component embeds a fixed model/effort route table.

## Rejected alternatives

- Hard-coding the supplied AAII/price ranking: quality and cost priors are not
  causal evidence for this framework's task mix.
- Selecting from aggregate model totals: confounding by task shape and failed
  work makes tokens per call incomparable to tokens per verified success.
- Inferring retries, escalation, or success from task names or model claims:
  those fields require host/runtime evidence and independent acceptance.
- Letting the repository runtime choose an endpoint or persist an experiment:
  that would violate the host-owned transport and privacy boundaries.

## Confirmation

- Routing parsers reject unknown/raw-sensitive fields and malformed assignments,
  enforce bounded workflow shapes, and freeze accepted values.
- Learner tests prove arithmetic, stratification, reliability/minimum-sample
  gating, empirical recommendation changes, and deterministic ties.
- Orchestrator tests prove assignment digest binding, authentic observer events,
  pre-approval evidence, receipt joins, and observer-failure isolation.
- Aggregate `check`, `typecheck`, `test`, package builds, plugin parity, and a
  clean-checkout reproduction remain release gates.

## Review triggers

- A host begins changing assignment or persistence semantics.
- A route is promoted without randomized/propensity evidence and independent
  causal verification.
- Routing records retain raw prompts, paths, titles, secrets, or unbounded
  model output.
- The repository begins owning endpoint credentials or live model selection.
