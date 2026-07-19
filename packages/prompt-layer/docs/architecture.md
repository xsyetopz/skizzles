# Codex Prompt-Layer Architecture

## Purpose and status

This document describes the Codex instruction semantics that constrain the
Skizzles prompt layer, the prompt-layer tooling implemented in this repository,
and the separate opt-in activation lifecycle. It is maintainer
documentation, not a record of any installed Codex configuration.

The status labels below are intentional:

- **Verified upstream Codex semantics** describes behavior established from
  immutable OpenAI source references.
- **Implemented Skizzles repository architecture** describes files and commands
  present in this repository.
- **Supported installer activation behavior** describes the implemented,
  explicit host-facing boundary. Repository packaging and dry runs are not
  evidence that this boundary has been activated on any host.

## Verified upstream Codex semantics

### `model_instructions_file` is a complete base override

For a new session, a non-empty `model_instructions_file` is loaded into Codex's
`base_instructions` configuration. Session creation selects an explicit base
override before a base persisted in conversation history and before the
selected model's metadata instructions. The file therefore replaces the
selected model's built-in base instructions; it is not appended to them.
[OpenAI's configuration loader reads the file as a base override](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/config/mod.rs#L3702-L3734),
and [session creation documents the priority
rules](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/session/mod.rs#L596-L647).

The upstream schema strongly discourages setting this field because departing
from Codex-sanctioned instructions will likely degrade model performance.
Treat the replacement as a versioned compatibility surface and validate it on
representative work before activation.
[The warning is part of the pinned configuration schema](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/config/src/config_toml.rs#L232-L244).

Conversation history can preserve a prior base instruction value. Validation
of a changed override should therefore use a fresh session rather than infer
new-session behavior from a resumed one.

### `developer_instructions` is a separate contribution

`developer_instructions` is carried separately from `base_instructions` and,
when non-empty, contributes a developer-role section. In the pinned assembly
path it follows rendered permission instructions and remains separate from
personality and available-skill contributions. It does not replace the base
instructions.
[OpenAI's initial-context assembly keeps these contributions distinct](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/session/mod.rs#L3193-L3303).

This layer is appropriate for concise, durable operator policy. Runtime facts
such as the active permissions, installed skills, or current collaboration
state do not belong in a static developer policy.

### `compact_prompt` affects local compaction only

For local history compaction, Codex uses `compact_prompt` when configured and
otherwise uses its built-in summarization prompt. The chosen text is synthesized
as the compaction task's user input; it is not an ordinary-turn instruction.
[The local compaction path constructs that synthetic input explicitly](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/compact.rs#L92-L120).

Providers that support remote compaction take a different branch. That branch
does not consume the local `compact_prompt`, so a configured value cannot be
assumed to govern remote compaction.
[The pinned compact-task dispatch distinguishes remote and local paths](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/tasks/compact.rs#L36-L73).

Use this layer only for concise continuation state needed after local
compaction: objective, accepted decisions, ownership, evidence, outstanding
validation, blockers, and next actions.

### Runtime contributions remain dynamic

A base override does not freeze the rest of Codex's turn context. The pinned
source assembles permissions, configured developer instructions, personality,
and skills separately. World-state construction adds `AGENTS.md`, collaboration
mode, environment, application, plugin, realtime, and extension contributions
according to the active runtime.
[OpenAI's world-state builder shows these dynamic sections](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/session/world_state.rs#L26-L94).

Skizzles must not copy permission profiles, skill catalogs, `AGENTS.md` content,
collaboration state, plugin state, or environment facts into its static applied
prompt. Those values can vary by session and remain owned by Codex's runtime.

### Generic `default.md` is not selected-model metadata

The upstream generic prompt is
`codex-rs/protocol/src/prompts/base_instructions/default.md`. Codex can instead
resolve the active baseline from selected-model metadata. The generic file is a
reviewable compatibility baseline for this repository, but its presence or
contents do not prove equivalence to the instructions for any selected model.
[The pinned generic prompt is available in the OpenAI repository](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/protocol/src/prompts/base_instructions/default.md).

The separate `codex-rs/prompts` crate exports operation-specific templates such
as compaction, permissions, review, and realtime prompts. Those templates are
not substitutes for the selected model's base instructions.
[Its pinned exports show that operation-specific boundary](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/prompts/src/lib.rs#L1-L25).

## Implemented Skizzles repository architecture

### Canonical and generated files

The current repository implements one pinned, one-file Git patch over the
generic upstream baseline.

| Path | Responsibility |
| --- | --- |
| `packages/prompt-layer/assets/manifest.json` | Exact upstream ref, canonical paths, SHA-256 digests, and byte counts for every prompt-layer artifact. |
| `packages/prompt-layer/assets/upstream/default.md` | Pinned generic OpenAI baseline. |
| `packages/prompt-layer/assets/upstream/LICENSE` | Checksum-locked upstream license text. |
| `packages/prompt-layer/assets/upstream/NOTICE` | Checksum-locked upstream notice text. |
| `packages/prompt-layer/assets/skizzles-base.patch` | Canonical one-file Git patch against the exact upstream path. |
| `packages/prompt-layer/src/cli.ts` | Thin public package facade and CLI composition root; preserves the package export and root-script CLI surface without owning lifecycle policy. |
| `packages/prompt-layer/src/lifecycle/contract.ts` | Public asset paths, packaged descriptor paths, mutation options, lifecycle operation types, and exact ordered write-set contracts. |
| `packages/prompt-layer/src/content-integrity.ts` | Shared trust-boundary rules for SHA-256 facts and non-empty LF-only text. |
| `packages/prompt-layer/src/repository-boundary.ts` | Default repository-root topology, canonical containment, filesystem identity checks, and durable file operations. |
| `packages/prompt-layer/src/lifecycle/operations.ts` | Build, check, patch-authoring, and immutable-rebase orchestration over inward-owned contracts. |
| `packages/prompt-layer/src/lifecycle/workspace.ts` | One operation-scoped `@skizzles/run-workspace` composition boundary that reclaims stale runs and allocates named scratch directories for patch helpers. |
| `packages/prompt-layer/src/assets/manifest.ts` | Strict manifest decoding, checksum facts, provenance construction, and generated-output comparison. |
| `packages/prompt-layer/src/assets/patch.ts` | Exact-position patch validation, Git blob identity checks, patch creation, and strict application. |
| `packages/prompt-layer/src/assets/upstream.ts` | The sole network adapter for immutable official OpenAI prompt, license, and notice fetches. |
| `packages/prompt-layer/src/mutation/process-identity.ts` | Cross-platform process-start identity and stale/live owner classification. |
| `packages/prompt-layer/src/mutation/protocol.ts` | Mutation owner/reclaim record schemas, parsing, and ownership equality. |
| `packages/prompt-layer/src/mutation/lock.ts` | Exclusive lock acquisition, stale-owner reclaim, ownership verification, and release. |
| `packages/prompt-layer/src/mutation/quarantine.ts` | Identity-bound cleanup of stale and release quarantine trees. |
| `packages/prompt-layer/src/transaction/journal.ts` | Transaction protocol version, strict journal schema, ordered-path validation, and serialization. |
| `packages/prompt-layer/src/transaction/commit.ts` | Durable staging, promotion, rollback, preflight, recovery, and target-state verification. |
| `packages/prompt-layer/assets/instructions/skizzles-base.md` | Generated applied prompt. |
| `packages/prompt-layer/assets/instructions/skizzles-base.provenance.json` | Generated portable provenance and legal digests. |
| `packages/prompt-layer/assets/instructions/developer-instructions.md` | Canonical static developer policy. |
| `packages/prompt-layer/assets/instructions/compact-prompt.md` | Canonical local-compaction continuation policy. |
| `packages/prompt-layer/assets/integrations/prompt-policy.json` | Canonical portable policy descriptor and packaged-path contract. |
| `packages/prompt-layer/assets/evaluations/shipped-language-policy.v2.json` | Version-bound lexical/context taxonomy with prohibited and allowed fixtures, staged at `evaluations/shipped-language-policy.v2.json`. |
| `packages/prompt-layer/src/shipped-language/policy.ts` | Strict corpus parser, exact-byte integrity binding, deterministic literal matcher, and redacted finding contract. |

Tests follow the contract owner rather than mirroring an obsolete source
monolith:

| Test path | Contract proved |
| --- | --- |
| `packages/prompt-layer/test/lifecycle/assets.test.ts` | Manifest integrity, deterministic generation, provenance, patch validation, authoring, and descriptor-path publication. |
| `packages/prompt-layer/test/lifecycle/rebase.test.ts` | Immutable ref validation, official fetch behavior, reviewed replay, rollback, and non-mutation on fetch failure. |
| `packages/prompt-layer/test/lifecycle/mutation-lock.test.ts` | Exclusive ownership, stale reclaim, replacement preservation, clock skew, and quarantine recovery. |
| `packages/prompt-layer/test/lifecycle/process-identity.test.ts` | PID reuse, Darwin identity normalization, locale/timezone stability, and fail-closed identity behavior. |
| `packages/prompt-layer/test/lifecycle/transaction.test.ts` | Promotion-fault rollback, hostile journal rejection, crash recovery preflight, and symlink containment. |
| `packages/prompt-layer/test/lifecycle/workspace.test.ts` | One-root patch composition, success/error/cancellation cleanup, and outside-sentinel preservation. |
| `packages/prompt-layer/test/cli.test.ts` | CLI argument rejection, LF enforcement, and machine-path hygiene. |
| `packages/prompt-layer/test/shipped-language/policy.test.ts` | Corpus shape and byte binding, ordered taxonomy coverage, allowed/prohibited fixtures, and lexical context behavior. |
| `packages/prompt-layer/test/lifecycle/fixture.ts` | Narrow package-owned fixture construction and cleanup shared by those contract suites; never imported by production code. |

### Structural audit disposition

The externally observed asset names
`evaluations/shipped-language-policy.v2.json`,
`instructions/skizzles-base.provenance.json`, and
`integrations/prompt-policy.json` are preserved because the versioned corpus
schema, prompt manifest, portable descriptor, installer validation, and plugin
parity checks bind their exact canonical and packaged paths. Their naming
exceptions belong to the repository-level architecture policy and must be
removed only through a versioned schema or plugin-layout migration.

The single-file `assets/evaluations`, `assets/integrations`, and
`assets/upstream` directories are stable distribution or provenance
boundaries, not speculative source layers. The package-local `docs` directory
owns the one complete prompt architecture record. The matching
`src/shipped-language` and `test/shipped-language` directories preserve one
security-sensitive policy owner and its contract suite without mixing them
into lifecycle orchestration. The shipped-language parser remains cohesive at
477 physical lines: it owns one exact corpus grammar, normalization pipeline,
lexical matcher, and redacted finding contract; it is below the extraction-plan
threshold and its adversarial suite exercises the combined boundary.

`@skizzles/plugin-builder` depends on `@skizzles/prompt-layer` through its
workspace export. It validates the canonical asset set, then stages only the
public `instructions/*`, `integrations/prompt-policy.json`, and
`third_party/openai-codex/{LICENSE,NOTICE}` destinations. Prompt authoring
inputs, lifecycle code, tests, the manifest, and the upstream baseline are not
distributed.

### Deterministic shipped-language scope

The version 2 corpus uses no data-supplied regular expressions. Each canonical
ASCII phrase is normalized with Unicode NFKC, lowercase conversion, and
collapsed horizontal whitespace, then matched on one physical line with
Unicode letter, mark, number, and underscore boundaries. The dependency phrase
also excludes only a complete neutral repository/workspace-boundary sentence;
additional trailing language removes that exemption. Apostrophe, curly
apostrophe, and every Unicode `Dash_Punctuation` continuation into another
letter remain part of the surrounding word. These lexical and narrow context
boundaries prevent pattern prefixes from matching words, possessives, or
compounds such as `memory`, `friend's`, and ASCII/U+2010/U+2011
`friend-shaped` variants without exempting punctuation-separated prohibited
fixtures.
Quoted text and fenced code are scanned. Negation has no semantic exemption: a
negated sentence is accepted only when its normalized text does not match a
prohibited literal. Ordinary first-person service language remains permitted.

The validator is a static product-language fitness function, not a
psychological effect measurement or a general semantic classifier. Its
deliberate static limitations are paraphrases, translations, phrases split
across lines, and constant runtime constructions assembled from separate
literals when the fixed transpiler does not emit the complete phrase. It can
reject quoted or policy-discussion text containing an exact prohibited phrase.
Corpus changes therefore require a new version or an explicit digest update
with review and must retain negative and allowed fixtures. Findings contain the
taxonomy ID, bounded relative path, and line number, never the matched text. C0 controls
other than tab/CR/LF, DEL/C1 controls, unpaired surrogates, and Unicode
line/paragraph separators are rejected before matching. Every Unicode
`Default_Ignorable_Code_Point`, including zero-width, byte-order-mark,
word-joining, bidi, variation-selector, and combining-grapheme-joiner code
points, is also rejected rather than allowed to splice or trail lexical tokens.
The same rule redacts diagnostic paths. This keeps line calculation limited to
CR/LF text and prevents invisible bypasses.

`@skizzles/plugin-builder` scans canonical runtime source and every staged
textual plugin surface before accepting a distribution. The canonical scan
intentionally over-approximates bundled TypeScript by scanning each composed
package's `src/` tree before destination mutation; resulting staged bundles are
scanned again. Every non-excluded canonical candidate is decoded and raw-scanned
as text through a contained, identity-checked, no-follow read. Descriptor size
is bounded before allocation, reads are explicitly bounded, identity and size
are rechecked after the read, growth is probed, and files with more than one
hard link are rejected. A new textual suffix therefore cannot bypass the
pre-mutation gate or import bytes through a link outside the owned tree.

Format-aware scanning is additive to the raw scan and never executes shipped
content. `surface-content.ts` owns classification and JSON/YAML/program dispatch;
`markdown-content.ts` and `plist-content.ts` privately own their bounded format
parsers, while `surface-errors.ts` owns only their shared redacted syntax/bounds
diagnostic contract:

- JSON and JSONC use Bun's parsers, bounded recursive traversal of every string
  key/value, and token decoding so duplicate overwritten keys cannot hide an
  escaped string.
- YAML uses the declared `yaml` package's strict document AST and decoded JS
  graph. Every scalar node is scanned before mapping overwrite, including
  tagged and anchored scalars. Shared DAG aliases are accepted; actual graph
  cycles, alias expansion, depth, node, and text bounds fail closed.
- TypeScript and JavaScript use fixed Bun transpilers only to parse and reveal
  escaped runtime literals; the output is scanned without import resolution or
  execution.
- Plist scanning uses a bounded non-resolving XML surface parser. It rejects
  malformed XML, DTDs, processing instructions after the XML declaration, and
  external or user-defined entity declarations; it decodes only predefined and
  numeric references. Ordinary text and adjacent CDATA fragments are accumulated
  into one decoded `string` or `key` value before scanning. Explicit depth,
  element/node, per-element and aggregate attribute, and collected-text budgets
  fail closed before unbounded amplification.
- Markdown is additively scanned through Bun's fixed renderer so HTML character
  references are decoded as rendered text. A bounded non-executing HTML pass
  then removes comments and a narrow allowlist of inert Markdown elements while
  joining adjacent visible text nodes. It strictly parses bounded attributes,
  rejects duplicates, event/style/namespace or unknown attributes, active URL
  schemes, and executable/unknown elements, and adds decoded `alt`, `title`, and
  `aria-label` values to the scanned text. Malformed markup fails closed. The
  pass never constructs a DOM or executes tags, attributes, URLs, scripts, or
  entities. Raw Markdown remains scanned as well. `.gitignore` uses raw text. The only staged extensionless text paths are
  `skills/codex-container-lab/scripts/codex-container-lab` and
  `skills/designer-runtime/scripts/designer-sim`.

The canonical template probe
`packages/plugin-builder/template/third_party/openai-codex/COPYING` is
raw-scanned only so the existing exact legal-directory validator retains its
diagnostic for a forbidden extra file. It is not a staged extensionless
allowlist entry.

Canonical semantic parsing is a detection pass before the established package
validators. If a canonical candidate is syntactically malformed, its existing
format/package owner retains the rejection and diagnostic; malformed content is
not copied into an accepted stage. At the completed staged boundary, semantic
parse errors fail closed because no later owner can make that shipped content
safe.

The completed stage permits Markdown, YAML, JSON, JSONC, TypeScript, JavaScript,
plist, `.gitignore`, and those two extensionless paths. The logo path is not a
path-only binary exclusion: both canonical and staged bytes must match the one
pinned canonical PNG digest and each other. The exact corpus and OpenAI/Container Lab legal files
are policy/legal exclusions rather than binary classifications. Any other
staged file type fails closed. Raw findings use the source-file line; findings
from decoded strings or transpiled text use the line within that deterministic
semantic representation.

The manifest currently pins OpenAI Codex commit
`bc5c9161b46feddc13282652fd2cfdf1e5bab4a9`. Its baseline role is explicitly a
generic upstream compatibility baseline, not a selected-model baseline claim.

### Commands and network boundary

| Command | Current behavior |
| --- | --- |
| `bun run prompt:build` | Offline. Verifies all pinned inputs, strictly applies the patch, and transactionally rewrites only the applied prompt and provenance. It also recovers a valid interrupted mutation before building. |
| `bun run prompt:check` | Offline and non-writing. Refuses active locks, recoverable lock artifacts, or pending transactions, then verifies the exact language corpus, generated output, and provenance. |
| `bun run prompt:patch -- <candidate-path>` | Offline. Creates a canonical patch from a reviewed candidate, proves exact replay, and transactionally updates patch, manifest, output, and provenance. If the path is omitted, the current applied output is the candidate. |
| `bun run prompt:rebase -- <40-hex-commit>` | The only networked operation. Performs normal mutation-lock acquisition, recoverable lock-artifact cleanup, pending-transaction recovery, and lock release. It accepts only a lowercase immutable 40-hex commit, fetches the baseline, `LICENSE`, and `NOTICE` from official raw OpenAI URLs, and reports old-patch replay evidence without applying the newly fetched inputs. |
| `bun run prompt:rebase -- <40-hex-commit> --candidate <candidate-path>` | After review, refetches the pinned inputs, creates and proves a new exact patch, and transactionally updates all seven canonical/generated files. |

`bun run check` runs the repository's Biome check and then
`bun run prompt:check`.

### Integrity and mutation guarantees

The implementation validates more than whether `git apply` happens to succeed:

- Every baseline, legal file, patch, and output fact must match the manifest's
  SHA-256 digest and byte count.
- Text inputs must be non-empty, LF-only, end in LF, and contain no NUL bytes.
- Applied prompts, reviewed candidates, and the manifest reject recognized
  machine-specific absolute paths.
- Applied prompts must begin at byte zero with the exact canonical provenance
  header and may not carry duplicate, contradictory, or hidden provenance.
- The patch must target exactly the pinned relative upstream path as one regular
  textual file. Creation, deletion, rename, copy, mode changes, binary patches,
  zero-context hunks, shifted hunks, malformed counts, and false Git blob
  identities are rejected.
- The implementation reconstructs each hunk at its declared position, then runs
  `git apply --check --whitespace=error-all` and `git apply`. Both results must
  reproduce the same exact output.
- Each top-level operation reclaims stale disposable runs, creates one private
  marked run root, and injects named author/apply directories into patch helpers.
  Success, failure, and cancellation close that root as one unit; synchronous
  Git invocations do not create fictitious child-process ownership adapters.
- Mutating operations use an identity-bound exclusive lock. Lock ownership
  includes operation, process ID, process-start identity, unique token, and
  creation time. Live or unverifiable owners fail closed; stale recovery uses
  identity-checked quarantine and bounded handling for incomplete lock state.
- Each mutation permits one exact ordered write set. Old and new bytes are
  durably staged with a strict journal before promotion. Recovery verifies the
  journal shape, operation, paths, order, digests, byte counts, staged content,
  backups, and target state before rollback or cleanup.
- `prompt:check` never performs recovery. A valid interrupted transaction is
  recovered by the next mutating command, normally `prompt:build`.

The upstream `LICENSE` and `NOTICE` are part of the checksum-locked derivation.
Any rebase must update and review them with the baseline; they are not optional
metadata.

### Threat-model limitation

Path containment rejects static symlinks and protects cooperating Skizzles
writers through the identity-bound lock. The implementation rechecks filesystem
identity immediately before destructive pathname operations and fails closed on
detectable replacement races.

This is not a race-free defense against an unrelated malicious local process.
The Node pathname APIs used here do not expose the `dirfd`/`openat` primitives
needed to eliminate that class of time-of-check/time-of-use race. Run the tools
only in a repository and host environment whose local writers are trusted.

## Maintainer workflows

### Update the Skizzles divergence on the current baseline

1. Copy `packages/prompt-layer/assets/instructions/skizzles-base.md` to a separate review candidate.
2. Edit the candidate without changing the canonical provenance header.
3. Review the complete candidate and its diff from
   `packages/prompt-layer/assets/upstream/default.md`.
4. Author and replay the patch:

   ```sh
   bun run prompt:patch -- reviewed-skizzles-base.md
   bun run prompt:check
   bun run check
   ```

5. Review changes to the patch, manifest, applied prompt, and provenance before
   creating a repository checkpoint.

Do not hand-edit `packages/prompt-layer/assets/skizzles-base.patch` or treat the
generated output as the canonical authoring surface.

### Rebase to a newer immutable Codex commit

1. Inspect the intended upstream commit and any changes to the generic prompt,
   `LICENSE`, `NOTICE`, configuration semantics, and compaction paths.
2. Run the review probe. It uses the normal mutation lock and recovery lifecycle
   before fetching upstream evidence:

   ```sh
   bun run prompt:rebase -- <40-hex-commit>
   ```

3. Review the reported baseline digest and old-patch replay result. Prepare a
   candidate derived from the fetched upstream content with the canonical
   provenance header updated to the new immutable commit.
4. Apply only the reviewed candidate:

   ```sh
   bun run prompt:rebase -- <40-hex-commit> --candidate reviewed-rebase.md
   bun run prompt:check
   bun run check
   ```

5. Inspect all seven changed prompt-layer files, verify legal text changes, and
   review the resulting patch rather than accepting a clean replay as approval
   of the repository change.

The first rebase command intentionally does not apply the newly fetched inputs.
It may still clean recoverable lock artifacts or restore a valid interrupted
transaction as part of the normal mutation lifecycle. This separates baseline
discovery from reviewed repository update/application; host activation remains
deferred.

### Roll back repository changes

Rollback is a repository operation, not a host-configuration operation. Restore
the complete coherent prompt-layer set from one known-good revision:

```sh
git restore --source=<known-good-revision> -- \
  packages/prompt-layer/assets/manifest.json \
  packages/prompt-layer/assets/upstream/default.md \
  packages/prompt-layer/assets/upstream/LICENSE \
  packages/prompt-layer/assets/upstream/NOTICE \
  packages/prompt-layer/assets/skizzles-base.patch \
  packages/prompt-layer/assets/instructions/skizzles-base.md \
  packages/prompt-layer/assets/instructions/skizzles-base.provenance.json
bun run prompt:check
```

Use that command only after confirming none of the listed paths contains
unrelated work. Restoring only the output or only the manifest creates an
incoherent digest-locked set and is expected to fail verification.

## Supported installer activation behavior

The generated plugin stages only the applied base, portable provenance,
developer policy, local-compaction prompt, portable policy descriptor, and the
pinned OpenAI `LICENSE` and `NOTICE` under `third_party/openai-codex/`. The
upstream baseline, patch, manifest, prompt authoring/rebase tooling, and tests
remain maintainer-only inputs.

Activation is never implicit in skill, harness, plugin, or orchestration
configuration installation. The explicit command is:

```sh
bun run packages/installer/src/cli.ts prompt-policy apply \
  --source-root /absolute/path/to/selected/skizzles \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex --dry-run
```

Apply validates the descriptor, hashes, provenance, legal inputs, containment,
and non-symlink source boundary. It copies the applied base to the stable
owner-only path `CODEX_HOME/.skizzles/prompt-policy/skizzles-base.md`, writes a
separate pending receipt, and uses native `config/batchWrite` to replace the
complete `model_instructions_file`, `developer_instructions`, and
`compact_prompt` values atomically. It never points Codex at a checkout or
plugin cache. Preview output reports only key names, prior-presence flags,
digests, byte counts, target classification, and the planned action.

Dry-run app-server reads use a disposable owner-only config snapshot outside
the selected home and remove it after the preview. The snapshot copies only
the selected config and the bounded relative read inputs it names, including
base/compact prompt files, model catalogs, nested role config files, and the
same fields below profile tables. Every copied source must remain within the
selected home, traverse no symlink, stay within byte limits, and retain its
filesystem identity through a no-follow read. Resolved preview paths are
remapped to selected-home paths before lifecycle comparison. The selected
`CODEX_HOME` therefore receives no app-server or installer writes during
preview. Apply, resume, restore, and recovery share one external identity-bound
lifecycle lock; live owners exclude concurrent operations, while stale and
incomplete owners are reclaimed only after filesystem and process-start
identity checks.

The owner-only receipt at
`CODEX_HOME/.skizzles/prompt-policy-receipt.json` records exact prior presence
and values. `prompt-policy restore` verifies the selected binary, config path,
three current replacement values, receipt facts, and managed base digest before
atomically restoring prior values. Missing prior values are deleted. Drift
causes no mutation and retains the evidence. Versioned pending and restoring
states permit safe retry or validated cleanup after interruption.
Only the current nested app-server wire shape
`error.data.config_write_error_code = "configVersionConflict"` classifies a
confirmed pre-write conflict and removes newly created apply evidence. The
other five `ConfigWriteErrorCode` enum members are allowlisted only for a
redacted diagnostic. Legacy `code`/`status` fields, unknown values, timeouts,
closed transports, and other ambiguous write outcomes retain
pending/restoring evidence. The next locked invocation reads all three values
and distinguishes exact before, exact after, and drift before deciding whether
to retry, finalize, restore, or refuse. Protocol diagnostics never expose
arbitrary app-server error data or stderr.

Applying or restoring requires a new session before instruction changes can be
evaluated. The configured `compact_prompt` governs local compaction only;
provider-managed remote compaction can bypass it.

## Sources and provenance

All OpenAI links in this document are pinned to immutable commit
`bc5c9161b46feddc13282652fd2cfdf1e5bab4a9`.

- [OpenAI Codex configuration fields and performance warning](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/config/src/config_toml.rs#L221-L244)
- [OpenAI Codex configuration loading](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/config/mod.rs#L3702-L3759)
- [OpenAI Codex base-instruction selection and session configuration](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/session/mod.rs#L596-L647)
- [OpenAI Codex developer-message, permissions, and skills assembly](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/session/mod.rs#L3193-L3303)
- [OpenAI Codex dynamic world-state assembly](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/session/world_state.rs#L26-L94)
- [OpenAI Codex local compaction path](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/compact.rs#L92-L120)
- [OpenAI Codex remote/local compact-task dispatch](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/core/src/tasks/compact.rs#L36-L73)
- [OpenAI Codex generic base prompt](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/protocol/src/prompts/base_instructions/default.md)
- [OpenAI Codex operation-specific prompt exports](https://github.com/openai/codex/blob/bc5c9161b46feddc13282652fd2cfdf1e5bab4a9/codex-rs/prompts/src/lib.rs#L1-L25)
- [Imported architecture source at its immutable revision](https://github.com/xsyetopz/.codex/blob/ce9d944bd2f7448c920d0a2cc8212a9bea4b0a67/docs/skizzles-prompt-layer-architecture.md)

The imported source was used as historical evidence. Machine-specific state,
installed configuration snapshots, transient runtime validation, and claims not
supported by the current repository were intentionally excluded.
