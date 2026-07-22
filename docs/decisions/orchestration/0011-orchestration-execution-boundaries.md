# 0011: Separate orchestration execution capabilities

Status: Superseded by [ADR 0014](../workspace/0014-task-worktree-boundary.md)

The durable publication boundary remains current. ADR 0014 replaced the
orchestrator-owned command-profile and disposable-run composition described
below with the authenticated task-worktree lifecycle; the old copy-staging
execution path has no compatibility route.

## Context

Phase 2 adds target baselines, execution budgets, recoverable publication,
command auditing, bounded discovery, owned-resource cleanup, quotas, and
single-use approval gates. These controls have different trust and lifecycle
boundaries. Durable publication journals outlive an orchestrator instance,
whereas repository policy and approval state do not. Existing package-private
plugin and Container Lab transactions are domain-specific and cannot become a
general workspace writer without reversing ownership or creating cycles.

## Decision

- `@skizzles/orchestrator` owns target reservations, discovery completeness,
  host-owned budgets, command outcome profiles, approval state, and the causal
  execution workflow.
- `@skizzles/workspace-publication` owns repository-scoped leases,
  destination-owned siblings, durable journals, and deterministic recovery.
- `@skizzles/command-observation` exposes a direct-argv observation API with
  bounded immutable process evidence. Stderr is evidence unless a named profile
  explicitly requires it to be empty.
- `@skizzles/scratchspace` exposes exact-root, fail-closed quota inspection and
  retains ownership of disposable roots and child shutdown.
- Composition uses intentional public package APIs only. The orchestrator never
  imports plugin-packaging or package-private Container Lab transaction code.

Multi-file publication is serialized for cooperating processes and atomic per
file. The journal provides deterministic old-set or new-set recovery around the
durable publication boundary; this is not a claim that the operating system can
atomically rename an arbitrary set of files.

Approval is consumed before an uncertain publication attempt. Recovery may
finish that exact transaction, but the approval cannot start a second one.
Cleanup operates only on authority-issued exact resource receipts and never on
foreign mounts, volumes, labs, or workspace roots.

## Consequences

- Durable state has a dedicated package and recovery contract.
- Command success is profile-specific rather than inferred from stderr text.
- Incomplete discovery, unknown quota state, unconfirmed process cleanup,
  target drift, approval replay, and publication uncertainty fail closed.
- Plugin-builder remains the sole generated distribution owner and can later
  consume these packages without a reverse dependency.

## Fitness checks

Phase 2 acceptance requires package-local positive, negative, boundary, race,
replay, crash-recovery, quota, and cleanup tests; an integration test through
the actual orchestration workflow; workspace architecture checks; aggregate
typechecking and tests; all package builds; and generated-plugin parity.
