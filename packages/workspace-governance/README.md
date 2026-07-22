# Workspace policy

`@skizzles/workspace-governance` verifies the repository's Bun/TypeScript package
contract. It checks package ownership, public-surface budgets, direct dependency
closure and cycles, exported package subpaths, relative-import containment,
production-to-test direction, source-module strongly connected components,
static cross-package filesystem paths,
package-local documentation and tests, the single root lockfile, and removal of
superseded source layouts. Authored TypeScript is owned by `src/` or `test/`;
generated, vendored, dependency, and build-output directories are excluded.
Files above 650 physical lines require a package-local
`architecture-reviews.json` responsibility record, files above 800 fail,
and executable entrypoints have a 200-line budget. Declared TypeScript exports
and optional binaries are compiled in memory as package-entrypoint smoke tests.
Every manifest dependency map is typed and validated. Production imports may
use direct `dependencies`, `optionalDependencies`, or `peerDependencies`; tests
may additionally use `devDependencies`. Local entries in all four maps require
`workspace:*`. Optional and peer edges participate in cycle detection because
they can back real TypeScript imports and Bun workspace links. The orchestration
root may own development dependencies only; runtime, optional, and peer maps
are rejected.

Under the pinned Bun 1.3.14 linker contract, a package consumed through any
package or root dependency map must not declare `bin`: install creates a
consumer-local `.bin` link and chmods the dereferenced target from 0644 to 0777.
Standalone repository-tool packages may retain intentional binaries; the
policy rejects the hazardous dependency shape rather than imposing a blanket
binary ban.
TypeScript exports are then imported in isolated Bun processes with stdin held
open. A five-second lifecycle observation budget covers the importer exit and
concurrent stdout/stderr EOF. Exceeding that configured deadline without all
three events while stdin remains open fails validation, as does the first output
byte, a nonzero exit, or a stream failure, without accumulating output. On POSIX,
each importer leads a detached process group: failures kill the group and verify
its removal, and a clean importer exit is followed by a group probe so silent
descendants with ignored stdio are also rejected. Cleanup failures remain
validation failures.

This lifecycle gate assumes trusted package code; it is not a malicious-code
sandbox. A descendant that deliberately creates a new session or otherwise
re-detaches can escape POSIX process-group containment. Windows has no
negative-PGID detection here, so the gate kills and reaps the direct importer
for observable lifecycle failures but cannot make the POSIX descendant checks.

The package exports `validateWorkspace` for tests and exposes the
`skizzles-workspace-policy` executable. It does not modify the workspace.
The default validator and executable invocation always run the complete
workspace policy and architectural fitness gate:

```sh
bun run workspace:check
```

Architectural fitness has no debt baseline or suppressions.

Static filesystem reach-through is intentionally limited to literal
`packages/<owner>/...` paths in production TypeScript. Dynamic paths cannot be
classified reliably without executing package code; cross-package imports,
including private subpaths, merge Bun's parsed runtime/dynamic import scan with a
TypeScript 7 asynchronous AST pass for static imports, re-exports, import type nodes,
external import-equals declarations, and triple-slash path and types directives.
Path directives are normalized to relative filesystem edges; types directives retain
their TypeScript package specifier and pass through the same direct-dependency and
export checks as imports. Triple-slash lib directives select compiler-owned standard
libraries rather than workspace or package dependencies, so they are intentionally
excluded. One API and snapshot open all eligible files
per workspace validation; syntactic diagnostics and backend or cleanup failures fail
closed as `source-parse-error`. The snapshot is disposed before the API is closed.
Discovery first retains each file's exact bytes as A. TypeScript independently reopens
the owned path, then, after snapshot disposal and API close, policy reads exact bytes B.
Only A-equals-B files may contribute Bun or AST edges; a mismatch or reread failure is
a deterministic `source-parse-error` and contributes no SCC or dependency evidence.
This trusted-project stable-read bracket detects ordinary changes during parsing but
cannot exclude a hostile same-user ABA rewrite that restores A after TypeScript saw a
different generation.
Literal specifiers are decoded by TypeScript, then the Bun and AST results are sorted
and deduplicated before policy and local-SCC analysis. Comments, ordinary strings,
templates, regular expressions, JSX text, and JSDoc are inert. The pass does not
resolve identifiers, infer `tsconfig` aliases, classify nonliteral specifiers, or run
semantic type checking.

TypeScript 7.0.2 is an exact runtime dependency. Package builds externalize `typescript` and
`typescript/*`, leaving the installed dependency responsible for its asynchronous API
and native `tsgo` executable. macOS arm64 is the locally verified platform; a clean
Linux checkout must repeat frozen install, build, and built-entrypoint runtime proof
before release. TypeScript upgrades and supported-platform changes require explicit
parser, lifecycle, optional-native-package, and runtime review.
The plugin builder is the explicit canonical-to-generated artifact composition
owner and is exempt from the static path-literal rule. A direct package
dependency alone does not grant filesystem reach-through authority.

## Repository security tools

This package also owns the networked repository security gate invoked by
`bun run security:check`. The root
`config/security-tools.json` pins the exact actionlint, ShellCheck,
and Gitleaks release provenance and Linux x64/macOS arm64 archive contracts. A
code-owned immutable authority independently binds every version, license, command,
pattern, release URL, archive digest, executable member, and GitHub API identity
field; mutually consistent manifest drift still fails.
Unsupported platforms fail deterministically. Each gate invocation first runs the
bounded stale-workspace janitor, then creates exactly one marked
`@skizzles/scratchspace` root. Archives, extracted tools, causal probes, and reports
all remain beneath that root until whole-root cleanup. Archives are downloaded with byte
and time bounds. Every redirect hop is
manually host/protocol checked; GitHub release API asset identity, byte count, and
digest are pinned; bytes are verified before selective tar extraction, checked for
contained regular executable members, and version-tested. Every tool and Git process
registers its complete detached process-group scope before it is awaited; cancellation,
timeouts, output overflow, exceptions, and normal completion stop or confirm children
before the marked root is deleted. Cleanup failures retain the root and fail the gate.
No package manifest carries these tools and no persistent tool cache is used.

The gate passes every real `.github/workflows/*.{yml,yaml}` file to actionlint
with an explicit pinned ShellCheck executable, parses actionlint JSON output, and
runs invalid-event, invalid-expression, invalid-`needs`, unquoted-shell, and
corrected-workflow causal probes. A typed YAML AST binds each readable action version
comment to the exact direct job/step `uses` scalar. Flow, block-scalar, alias,
merge-derived, tagged, quoted/escaped, continued, duplicate, and ambiguous action
values are rejected rather than matched by reference text elsewhere in the file.
External actions require exact untagged plain source bytes; unrelated `run` block
scalars remain supported. Gitleaks scans the current tree and complete Git
history with 100% redaction and owner-only JSON reports held inside the run root. Only exit zero
plus an exact empty report and clean diagnostics is clean; only exit 10 plus a
nonempty fully redacted report is findings. Other statuses, warning/error/skip
diagnostics outside the pinned stderr grammar, or mismatched reports fail
operationally. Redacted matches may retain bounded printable assignment context but
must contain exactly one marker and no probe token. Provider-token, generic-assignment,
exact-canary, adjacent-token, removed-history, and real unreadable-file probes prove the classifier.
The `.gitleaks.toml` allowance is restricted to the one documented fake privacy
canary; it does not allow the test path or disable a default rule.

This gate requires network access to the pinned GitHub release assets and a full
Git checkout. It is mandatory in CI/release acceptance but intentionally separate
from `verify`, which does not acquire these security binaries. actionlint does not
replace an actual GitHub Actions run, and Gitleaks is heuristic rather than proof
that a tree contains no credential.
