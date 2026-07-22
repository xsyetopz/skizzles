# `@skizzles/verification-gate`

Phase 6 acceptance aggregation for an exact repository task candidate. The
package does not edit source, compile code, inspect Git, run SAST, or construct
task context. It accepts only opaque authorities created by this package and
binds their current evidence to one repository, root, task, request, tree,
baseline, candidate, canonical candidate-file manifest, and specification lock.

`createVerificationGate` exposes `evaluate` and `verify`. Evaluation derives a
complete mutant inventory from the authenticated modified executable map,
rejects surviving and timed-out mutants, permits invalid or equivalent mutants
only through exact independent exclusions, checks deterministic property runs,
enforces host-fixed per-node, per-modified-line, and per-branch hit thresholds,
proves the original tests ran against the exact baseline manifest with a
candidate production overlay, and calls a distinct reviewer last. Modified
lines are represented only by opaque source-authority digests. Coverage must
echo the exact objective digest and report every authenticated node, line, and
branch without omissions, duplicates, or additions. Review cannot waive an
objective failure. Verification replays the authorities and accepts only an
identical current result.

The source, change-assurance, aggregate task-worktree, and individual task
profile reports must all echo the same `candidateManifestDigest`. The digest is
validated through `@skizzles/candidate-manifest`; omissions, drift, noncanonical
order-derived digests, and mixed profile manifests are rejected before review.

Receipts are bounded, frozen, digest-only summaries. They contain no source
bytes, artifact bytes, repository roots, or executable callbacks. Source,
change-assurance, and task-worktree public receipts are intentionally consumed
through isolated authority adapters so their authentic public guards can be
wired without making this package a second owner of those domains.
