# Workspace policy

`@skizzles/workspace-policy` verifies the repository's Bun/TypeScript package
contract. It checks package ownership, public-surface budgets, direct dependency
closure and cycles, exported package subpaths, relative-import containment,
production-to-test direction, static cross-package filesystem paths,
package-local documentation and tests, the single root lockfile, and removal of
superseded source layouts. Authored TypeScript is owned by `src/` or `test/`;
generated, vendored, dependency, and build-output directories are excluded.
Files above 650 physical lines require a package-local
`architecture-file-reviews.json` responsibility record, files above 800 fail,
and executable entrypoints have a 200-line budget. Declared TypeScript
exports and binaries are compiled in memory as package-entrypoint smoke tests.
TypeScript exports are then imported in isolated Bun processes with stdin held
open. One deadline covers the importer exit and concurrent stdout/stderr EOF,
and the first output byte, a nonzero exit, a stream failure, or a lifecycle
timeout fails validation without accumulating output. On POSIX, each importer
leads a detached process group: failures kill the group and verify its removal,
and a clean importer exit is followed by a group probe so silent descendants
with ignored stdio are also rejected. Cleanup failures remain validation
failures.

This lifecycle gate assumes trusted package code; it is not a malicious-code
sandbox. A descendant that deliberately creates a new session or otherwise
re-detaches can escape POSIX process-group containment. Windows has no
negative-PGID detection here, so the gate kills and reaps the direct importer
for observable lifecycle failures but cannot make the POSIX descendant checks.

The package exports `validateWorkspace` for tests and exposes the
`skizzles-workspace-policy` executable. It does not modify the workspace.
The default validator and executable invocation retain the aggregate repository
gate while the oversized-owner migration is active. Run the strict fitness gate
explicitly with `validateWorkspaceArchitecture` or:

```sh
bun run packages/workspace-policy/src/cli.ts --architecture-fitness .
```

Strict fitness has no debt baseline or suppressions. It joins the default gate
only after the current repository passes it.

Static filesystem reach-through is intentionally limited to literal
`packages/<owner>/...` paths in production TypeScript. Dynamic paths cannot be
classified reliably without executing package code; cross-package imports,
including private subpaths, remain fully checked from Bun's parsed import scan.
The plugin builder is the explicit canonical-to-generated artifact composition
owner and is exempt from the static path-literal rule. A direct package
dependency alone does not grant filesystem reach-through authority.

## Repository security tools

This package also owns the networked repository security gate invoked by
`bun run security:check`. The root
`config/repository-security-tools.json` pins the exact actionlint, ShellCheck,
and Gitleaks release provenance and Linux x64/macOS arm64 archive digests.
Unsupported platforms fail deterministically. Archives are downloaded with byte
and time bounds into an owner-only temporary directory. Every redirect hop is
manually host/protocol checked; GitHub release API asset identity, byte count, and
digest are pinned; bytes are verified before selective tar extraction, checked for
contained regular executable members, version-tested, and removed on success or
failure. No package manifest carries these tools and no persistent tool cache is used.

The gate passes every real `.github/workflows/*.{yml,yaml}` file to actionlint
with an explicit pinned ShellCheck executable, parses actionlint JSON output, and
runs invalid-event, invalid-expression, invalid-`needs`, unquoted-shell, and
corrected-workflow causal probes. Gitleaks scans the current tree and complete Git
history with 100% redaction and ephemeral owner-only JSON reports. Only exit zero
plus an exact empty report and clean diagnostics is clean; only exit 10 plus a
nonempty fully redacted report is findings. Other statuses, warning/error/skip
diagnostics, or mismatched reports fail operationally. Provider-token, exact-canary,
adjacent-token, removed-history, and real unreadable-file probes prove the classifier.
The `.gitleaks.toml` allowance is restricted to the one documented fake privacy
canary; it does not allow the test path or disable a default rule.

This gate requires network access to the pinned GitHub release assets and a full
Git checkout. It is mandatory in CI/release acceptance but intentionally separate
from `verify`, which does not acquire these security binaries. actionlint does not
replace an actual GitHub Actions run, and Gitleaks is heuristic rather than proof
that a tree contains no credential.
