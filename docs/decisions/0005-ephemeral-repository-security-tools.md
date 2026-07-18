# ADR 0005: Adopt ephemeral pinned repository security tools

- **Status:** Accepted
- **Date:** 2026-07-18
- **Decision owner:** workspace policy and repository CI
- **Scope:** GitHub Actions validation and repository credential scanning

## Context

The repository has one 33-line Actions workflow and five embedded Bash lines. Generic
YAML parsing and Biome do not validate Actions events, expressions, job dependencies,
or embedded shell semantics. The public Actions API exposed no successful run at the
time of inspection, so local source checks could not borrow runtime evidence. Existing
plugin hygiene rejects credential-shaped filenames but does not scan arbitrary current
or historical content. Gitleaks identifies the deliberate OpenAI-shaped fake canary in
`packages/usage-analyzer/test/privacy-boundary.test.ts`, which requires one exact
allowance rather than a path exemption.

The CLI ecosystem catalog was used only to discover candidates. Primary releases,
repositories, licenses, archive layouts, version outputs, and artifact bytes were then
inspected independently. The demonstrated gaps are distinct from TypeScript AST,
general static-analysis, and Markdown-style gaps.

## Decision

Adopt exactly these repository-verification tools:

| Tool | Pin and provenance | License | Purpose |
| --- | --- | --- | --- |
| actionlint | `v1.7.12`, commit `914e7df21a07ef503a81201c76d2b11c789d3fca`, [upstream release](https://github.com/rhysd/actionlint/releases/tag/v1.7.12) | MIT | Parse and semantically validate actual Actions workflows with machine-readable findings. |
| ShellCheck | `v0.11.0`, commit `aac0823e6b58f8a499e856e93738082691cbf212`, [upstream release](https://github.com/koalaman/shellcheck/releases/tag/v0.11.0) | GPL-3.0-or-later | Analyze shell embedded in Actions through actionlint's explicit executable path; never redistribute it. |
| Gitleaks | `v8.30.1`, commit `83d9cd684c87d95d656c1458ef04895a7f1cbd8e`, [upstream release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) | MIT | Heuristically scan the current tree and complete Git history for credential content. |

The workflow's action dependencies are separate executable supply-chain inputs. The
mutable major tags are replaced with the exact commits published by the official
repositories: [actions/checkout v4.3.1](https://github.com/actions/checkout/releases/tag/v4.3.1)
at `34e114876b0b11c390a56381ad16ebd13914f8d5`, and
[oven-sh/setup-bun v2.2.0](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0)
at `0c5077e51419868618aeaa5fe8019c62421857d6`. Readable version comments remain beside
the commits. The workspace-policy gate rejects mutable, unknown, mismatched, missing,
or multiply declared remote actions; a pin change therefore requires code, workflow,
and primary-provenance review together. Pin comments are read from the exact YAML
scalar node that supplies each direct job or step `uses` value, not from a global
text match. External action values must be untagged, unquoted, single-line plain
scalars whose decoded value, parser source, and exact source bytes agree. Flow maps,
block-scalar action values, quoted escapes or continuations, explicit tags, aliases,
merge-derived values, duplicate keys, and ambiguous annotations fail closed. Ordinary
block scalars remain valid for unrelated fields such as `run`.

The root `config/repository-security-tools.json` is the strict versioned manifest.
It supports only CI Linux x64 and maintainer macOS arm64 because those exact upstream
archives were inspected. Every asset records the official GitHub release API URL,
release and asset IDs, byte size, update timestamp, and API-provided SHA-256 digest;
an immutable code-owned authority independently binds those fields together with the
tool version, license, version command and output pattern, release URL and basename,
archive SHA-256, and executable member path. Internally consistent manifest drift is
therefore rejected rather than becoming a new authority. Downloaded bytes matched
the primary metadata. Tests independently pin the complete versioned manifest byte
digest, so coordinated production-authority and manifest drift still requires an
explicit acceptance-evidence review. actionlint and Gitleaks additionally
publish separate release checksum files. ShellCheck has no separate checksum or
signature asset, but its release API provides the matching digest. ShellCheck source
notices at the pinned commit grant GPL version 3 or later; its legacy Cabal/Hackage
package metadata normalizes `GPL-3` as `GPL-3.0-only`, a discrepancy retained as
review evidence rather than flattened into the source-license conclusion. Windows and
other platform claims are rejected until their exact artifacts are verified and added.

`@skizzles/workspace-policy` owns parsing, acquisition, extraction, execution, and
causal probes. Acquisition uses HTTPS release URLs, manually follows at most five
redirects, validates HTTPS and an approved GitHub host at every hop, rejects loops or
missing/unsafe locations, applies a 60-second timeout and 64 MiB maximum, and verifies
the API-recorded byte length and exact SHA-256 before any extraction. A private
temporary directory holds archives and executables. Tar listings reject
absolute, parent, non-normalized paths and duplicate executable entries; member
metadata and post-extraction checks reject symlink, hard-link, or non-regular
executables. Extraction selects only the named executable, sets exact owner modes,
verifies the real path and reported version, and cleans the complete directory on
success or failure. Commands use argument arrays rather than shell interpolation and
impose output/time limits with process-group termination.

actionlint receives every actual `.github/workflows/*.{yml,yaml}` path and the pinned
ShellCheck path, with JSON findings. Causal probes require invalid event, expression,
`needs`, and unquoted expansion failures plus a corrected-workflow pass. Gitleaks runs
`dir` and full-history `git --log-opts=--all` scans with `--redact=100` and a distinct
findings exit code of 10. Exit zero is clean only with an exact empty JSON report and
no warning, skip, or error diagnostics. Exit 10 is findings only with a nonempty,
strictly typed, fully redacted JSON report whose count matches the sole findings
warning. `Secret` must be exactly `REDACTED`; bounded printable `Match` values may
retain safe assignment context such as `api_key = 'REDACTED'`, but must contain one
redaction marker. A version-pinned whitelist accepts only the observed scanned,
optional commit-count, clean-terminal, and findings-terminal diagnostic lines. Every
other exit/status/report/diagnostic combination is an operational
failure. Reports are bounded, mode `0600`, nested under the owner-only temporary root,
parsed only after the process exits, and deleted in `finally`; captured findings are
withheld at the aggregate boundary. Configuration extends defaults and narrowly
allows the exact known fake privacy canary. A named fixture rule proves that an
adjacent unlabeled token still fails. Disposable probes also prove a provider-like key,
a committed-then-removed key, and a real unreadable-file skip cannot be mistaken for
success or findings, without exposing the raw tokens.

`bun run security:check` is the one aggregate authority. CI invokes it once after the
separate `verify` aggregate and checks out complete history with
`fetch-depth: 0`. Network, release-host, checksum, tool-version, or full-history
availability failures fail closed. Release acceptance runs the same root command.

## Considered alternatives

- **ast-grep:** rejected as a gate. No repository gap requires a second TypeScript
  structural-query engine beyond TypeScript, Biome, and workspace policy.
- **Semgrep:** rejected. Its broad rule/runtime/supply-chain surface is not justified
  by a distinct causal gap in this packaging workspace.
- **markdownlint-cli2:** deferred. Markdown consistency remains a typed/documentation
  debt, not evidence for adding a networked release gate now.
- **Generic YAML parsing alone:** rejected as an Actions verifier because it cannot
  prove Actions semantics or embedded shell. A direct `yaml` AST dependency is used
  only to bind each action pin annotation to its exact source scalar; actionlint owns
  Actions-specific semantic and embedded-shell validation.
- **Homebrew/global installation or vendored binaries:** rejected. Both introduce
  mutable host state or repository artifacts outside the package owner and pin
  contract.
- **`curl | sh`, unverified downloads, and persistent reports/caches:** rejected as
  supply-chain and credential-retention risks.
- **Putting the networked gate inside `verify`:** rejected. `verify` remains
  independent of these security release assets; CI/release makes the separately
  named network gate mandatory exactly once.

## Consequences and limitations

- CI now needs full Git history and GitHub release availability.
- Tool upgrades require manifest, checksum, version, provenance, license, archive,
  negative-test, and actual-platform revalidation together.
- actionlint catches source-level Actions and embedded-shell errors but cannot prove a
  hosted run, runner-image behavior, action availability, permissions at runtime, or
  third-party action source or transitive supply-chain integrity. Full commit pins
  bound reviewed inputs but do not establish their safety. An actual GitHub run and
  upstream-source review remain separate evidence.
- Gitleaks is heuristic: an exact clean result is not proof that no credential exists.
  Strict status/report classification prevents known skipped/error ambiguity, while
  redaction and non-retention reduce exposure; neither makes a third-party detector a
  secrecy oracle.
- Typed validation for non-Action YAML remains separate debt.

## Fitness checks

```sh
bun test packages/workspace-policy/test/repository-security.test.ts
bun run --cwd packages/workspace-policy typecheck
bunx @biomejs/biome@2.5.4 check --config-path biome.jsonc --vcs-root . \
  config/repository-security-tools.json .gitleaks.toml \
  packages/workspace-policy/src/repository-security \
  packages/workspace-policy/src/security-cli.ts \
  packages/workspace-policy/test/repository-security.test.ts
bun run packages/workspace-policy/src/cli.ts --architecture-fitness .
bun run security:check
```

The final command causally verifies exact downloaded versions and checksums, the real
workflow, real current tree, real full history, synthetic failure/pass probes,
redaction, and cleanup.

## Review and supersession

Review on any tool release/security notice, archive or checksum publication change,
platform expansion, false-positive incident, missed credential incident, Actions
schema/runtime change, or CI availability regression. Gitleaks' security-only
maintenance phase is an explicit annual review trigger. Remove a tool when its gap
moves into an equal-or-stronger native repository/hosted control; removal must delete
its manifest entries, runner, probes, CI expectation, configuration, and documentation
in one change. Supersede this ADR before adding another external repository gate.
