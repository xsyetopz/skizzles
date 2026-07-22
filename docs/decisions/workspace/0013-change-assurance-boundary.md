# 0013: Add a pre-publication change-assurance boundary

Status: Accepted

## Context

Phase 4 must reject insecure entry points, destructive migrations, custom
security mechanisms, performance regressions, hallucinated dependencies,
credential material, injection sinks, vulnerable packages, and incompatible
licenses. Source transformation cannot own these policies without becoming a
security, database, benchmarking, and package-registry monolith. The
orchestrator also cannot accept caller-authored success flags or expose source
bytes in approval receipts.

## Decision

- `@skizzles/change-assurance` is the independently testable pre-publication
  owner for Phase 4 evidence.
- A trusted host issues an authentic change declaration with exact target
  operations and structured plans for four domains: middleware and security,
  migration/configuration/secrets, performance, and supply chain.
- Each domain has a dedicated authentic factory and authority. The generic
  extension constructor remains package-internal, so callers cannot register
  an always-accept callback or mint a structural fake.
- `ChangeAssurance.assess(unknown)` accepts exact frozen baseline and candidate
  bytes, binds every domain result to the declaration and repository identity,
  and emits an authentic digest-only receipt.
- Source-engineering artifacts expose independently copied authenticated
  baseline and candidate readers. The orchestrator validates both channels,
  runs change assurance after source preparation, and blocks physical
  integration and Phase 2 approval until assurance succeeds.
- The assurance receipt is part of the engineering preview, workflow evidence,
  displayed diff, approval reference, and promotion-time evidence validation.

## Rejected alternatives

- Re-reading baseline files by pathname after source preparation is rejected
  because pathname races and test-only virtual sources would break exact
  baseline identity.
- Caller-provided policy callbacks and self-reported benchmark or security
  results are rejected because method copies could bypass every Phase 4 gate.
- Folding Phase 4 into source-transformation is rejected because parsers and
  formatters are not authorities for sessions, migrations, runtime metrics,
  registries, vulnerabilities, or licenses.
- Returning source bytes or complete plans in receipts is rejected because the
  approval surface needs verifiable bindings, not a second data-exfiltration
  channel.

## Consequences

- Every engineering publication requires a host-issued declaration and one
  authentic extension for each assurance domain.
- Security and performance checks can use physical or host-owned authorities
  without widening the orchestrator's public command surface.
- Policy and authority drift reject before approval. Method-copy facades,
  mutable bytes, proxies, accessors, missing domains, and malformed evidence
  fail closed.
- New assurance domains require an explicit architecture decision because they
  alter the declaration and receipt contract.

## Fitness checks

Acceptance requires facade and declaration authenticity tests, hostile
proxy/accessor tests, exact-byte and digest-only receipt tests, domain policy
positive and negative tests, a real source-to-assurance-to-publication workflow,
preview/diff/approval binding assertions, workspace architecture checks,
aggregate verification, and generated-plugin parity.
