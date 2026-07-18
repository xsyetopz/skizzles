# ADR 0003: Bound agent judgment with typed trust and independent evaluation

- **Status:** Accepted
- **Date:** 2026-07-18
- **Decision owner:** existing agent, prompt, orchestration, and evaluation owners
- **Scope:** agent context, handoffs, tools, observability, prompts, and acceptance tests

## Context

Skizzles already owns agent guidance and orchestration surfaces. Adding a parallel
agent framework would create duplicate lifecycle and policy authorities. Research in
the ledger supports explicit workflows, bounded specialist judgment, context
provenance, capability-boundary guardrails, and independent review. It also documents
evaluation failures caused by verifier access, leaked solutions, hard-coded fixtures,
test manipulation, and exit-code-only checks.

LLM output is probabilistic and may transform attacker-controlled or stale data. A
model's fluent summary, self-review, or confidence statement is not validation.

## Decision

Strengthen the existing owners around this contract:

### Context and trust

Context crossing an agent or tool boundary carries typed metadata for:

- origin and retrieval/creation time;
- trust class and integrity binding;
- applicable scope and version;
- retention and expiry;
- sensitivity and required redaction;
- transformations and their producer;
- validation status and validator.

Raw external input, retrieved content, tool output, generated code, summaries, and
LLM-transformed data remain untrusted until a deterministic parser or boundary-specific
check validates the property being consumed. A summary never inherits the source's
integrity merely because it cites it.

### Workflow and capability control

- Deterministic code owns state transitions, budgets, retries, cancellation, timeouts,
  cleanup, approval boundaries, and terminal outcomes.
- Model judgment is bounded to tasks where interpretation adds value. It returns a
  typed result that deterministic workflow code validates.
- Tool capabilities are least-privilege, scoped, attributable, and denied by default at
  destructive, secret-bearing, external-write, or host-state boundaries.
- Handoffs and reviews bind objective, inputs, artifacts, policy/model version, and
  acceptance contract. Stale or mismatched versions fail closed or require explicit
  revalidation.
- Observability records privacy-preserving actions, evidence references, decisions,
  errors, retries, cancellation, and outcome. It avoids raw secrets, unnecessary prompt
  bodies, or unbounded retention.

### Context compaction

Compaction is not enabled by documentation alone. A candidate must preserve errors,
constraints, provenance, accuracy, and privacy on representative and adversarial
workloads. Originals require bounded, access-controlled retrieval if reversibility is
part of the design. Adoption requires measured token/latency value and a bypass/removal
path. Headroom is a reference implementation, not an approved live proxy or dependency.

### Evaluation independence

Objective checks run before any model judge. Acceptance assets are separated from the
implementation context and integrity-bound. Evals include held-out/adversarial variants,
incident regressions, fixed retry policy, deterministic seeds where available, and both
mocks and causal smokes through the real boundary. The implementation agent cannot
approve its own work.

Negative tests cover verifier/test mutation, leaked answers, git-history or web solution
lookup where prohibited, prompt injection into graders, mocked/faked runtime effects,
hard-coded fixture answers, unsupported certainty, and deceptive claims of completion.
Passing means the requested causal behavior occurred, not merely that a command exited
zero or printed a success token.

### Anthropomorphic output

Shipped prompts, skills, examples, and UX use neutral technical language. Negative
fixtures reject claims of feelings, consciousness, embodiment, friendship, attachment,
personal need, autonomous intent, rights, or unsupported certainty. Politeness and clear
service framing remain permitted when they do not imply reciprocal relationship or
internal experience.

This is a product-language and trust rule, not a claim that every self-reference is
harmful. The source taxonomy is interpretive and its user effects were not directly
measured; fixtures therefore target concrete misleading claims rather than all first-
person grammar.

## Considered alternatives

- **A parallel agent runtime:** rejected; it duplicates current owners and lifecycle.
- **One comprehensive security/system prompt:** rejected; prompt text cannot enforce
  process, filesystem, network, secret, or verifier boundaries.
- **Self-review as acceptance:** rejected; authorship and acceptance need independent
  incentives and context.
- **Model judge as the first/only gate:** rejected; it is probabilistic and vulnerable
  to prompt injection and solution leakage.
- **Install Headroom or Sec-Context wholesale:** deferred/rejected for current scope;
  both introduce broad integration and trust surfaces without local measurements.
- **Ban all warm or first-person language:** rejected; the observable risk is misleading
  relationship/internal-state framing, not pronouns alone.
- **Adopt friendship/companion framing for engagement:** rejected for Skizzles. A narrow
  five-week ESL study cannot establish a safe general-purpose developer-tool contract.

## Consequences

- Context schemas and handoff contracts may add explicit metadata and validation work.
- Tests must keep implementation and hidden acceptance material separate.
- Security references are converted into focused checks at capability owners rather
  than injected as an unbounded prompt corpus.
- Observability optimizes for reconstructable evidence without retaining sensitive raw
  content.
- Prompt and plugin generation must keep negative-language fixtures at the canonical
  owner and prove generated parity.

## Fitness checks

Required checks include:

- schema/parser tests for absent, malformed, stale, redacted, and transformed context;
- capability denial, timeout, cancellation, retry, cleanup, and version-mismatch tests;
- hash/integrity failures for altered acceptance assets;
- held-out cases unavailable to the implementation context;
- incident fixtures for verifier injection, solution leakage, test mutation, hard-coded
  answers, fake effects, and output-token spoofing;
- causal smokes for every privileged or cross-process action;
- taxonomy-based negative prompt/plugin fixtures and canonical/generated parity;
- fixed judge version, prompt, retries, and recorded evidence whenever a model judge is
  used after objective gates.

No check may use its own fixture source as both implementation guidance and independent
acceptance evidence.

## Review and supersession

Review after a security incident, verifier escape, material model/tool lifecycle change,
new retained context class, new external action, youth/companion product scope, or
measured compaction pilot. Supersede this ADR before enabling a live context proxy,
persistent cross-agent memory, or relationship-oriented UX.
