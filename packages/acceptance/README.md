# `@skizzles/acceptance`

This package is the final acceptance aggregator for one exact repository-task
candidate. Orchestration hosts use it after source preparation, change
assurance, task-worktree validation, mutation testing, property runs, coverage,
original-test replay, and independent review have produced their evidence.

Use it to decide whether those authorities describe the same candidate and all
required gates passed. Do not use it to edit source, compile code, inspect Git,
run SAST, or construct task context; those concerns remain with their owning
packages.

## Public surface

The package root exports `createVerificationGate`, its authority factories and
guards, and the public receipt and report types. `createVerificationGate`
provides two operations:

- `evaluate` validates the current evidence and returns the complete result.
- `verify` replays the supplied authorities and accepts only a result identical
  to the current evaluation.

Only opaque authorities created by this package are accepted. Evaluation binds
one repository, root, task, request, tree, baseline, candidate, canonical
candidate-file manifest, and specification lock. It derives the full mutant
inventory, rejects surviving or timed-out mutants, checks deterministic
property runs and host-fixed coverage thresholds, proves the original tests ran
against the exact baseline manifest plus the candidate production overlay, and
calls a distinct reviewer last. Review cannot waive an objective failure.

Coverage must echo the objective digest and account for every authenticated
node, modified line, and branch without omissions, duplicates, or additions.
Invalid or equivalent mutants require exact independent exclusions. Modified
lines are represented only by opaque source-authority digests.

## Dependencies and limits

The source, change-assurance, aggregate task-worktree, and individual task
profile reports must carry the same `candidateManifestDigest`. The package
validates that digest through
[`@skizzles/candidate-manifest`](../candidate-manifest/README.md) before review,
so omissions, drift, noncanonical order-derived digests, and mixed profile
manifests fail closed.

Receipts are bounded, frozen, digest-only summaries. They contain no source
bytes, artifact bytes, repository roots, or executable callbacks. Source,
change-assurance, and task-worktree receipts enter through isolated authority
adapters; this package does not take ownership of those domains.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
