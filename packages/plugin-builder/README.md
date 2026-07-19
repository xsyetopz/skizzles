# `@skizzles/plugin-builder`

Private package for deterministic Skizzles plugin staging, validation, and
generated-tree drift checks.

The package stages allowlisted workspace package files into stable plugin
destinations, validates packaged prompt policy through
`@skizzles/prompt-layer`, bundles Container Lab entrypoints, and rejects local
state, unsafe paths, symlinks, and machine-specific content. The public
entrypoint exports the staging/check/build APIs; `skizzles-plugin-builder`
provides the repository CLI.

## Internal ownership

- `src/plugin/api.ts` is the stable public API; `src/cli.ts` is the executable
  composition root.
- `src/plugin/` owns canonical input declarations, deterministic staging,
  bundle creation, distribution validation, and tree comparison.
- `src/plugin/destination/` is one private crash-recovery state machine. Its
  claim, journal, retirement, recovery, cleanup, and promotion modules remain
  colocated because they share exact filesystem identities, protocol states,
  and fail-closed ordering; re-review the boundary if a module becomes usable
  without that transaction protocol.
- `src/prompt-policy/composition.ts` is the package-internal prompt-policy
  staging facade; its owner also contains contract parsing, containment,
  layout, and packaged-surface validation.
- `src/container-lab/composition.ts` owns the Container Lab distribution
  contract.
- `src/agent-contract/` pins exact published Fourth Wall and Completion
  Contract schema bytes, strictly parses/evaluates contract instances, executes
  every materialized public incident regression, rejects symlinked asset paths,
  rejects multi-link contract files, and proves staged copies are byte-identical
  to their canonical skill owners.
- `test/` follows those capabilities; `test/plugin/fixture.ts` is the single
  canonical isolated-workspace fixture builder and prompt-policy mutation
  support stays with `test/prompt-policy/`.

The manifest declares every workspace package whose canonical entrypoint is
composed into the distribution. Internal implementation modules are not
package exports.

## Public package APIs

The root `@skizzles/plugin-builder` export remains the staging facade only.
Independent contract consumers use the intentional
`@skizzles/plugin-builder/agent-contract` subpath. Its runtime export budget is
exactly `evaluateAgentContract` and `ContractRejection`; only the contract kind,
JSON value, and rejection-code types accompany them. The evaluator accepts
JSON-shaped evaluation options and parses their strict internal contract at the
production boundary, preventing callers from bypassing exact-key, identity,
chronology, and evidence checks.
Schema walkers, filesystem readers, corpus composition, staging validators, and
individual contract evaluators remain package-private.

The schema-byte digests in `src/agent-contract/contract.ts` are the plugin
composition authority and must change atomically with a deliberate published
schema revision. Plugin-builder does not claim to be a general JSON Schema
meta-validator. The typed evaluators own repository acceptance semantics that
JSON Schema cannot express, using explicit clock/version/digest options and
trusted harness facts.
Acceptance evaluation binds objective, acceptance, artifact, and runtime-effect
identities to those trusted facts. Its canonical v3 digest covers the complete
submitted acceptance record except for a zeroed self-digest field. Trusted test
results, actor eligibility, judge outcome, findings, run chronology, expiry,
and prior-run IDs are exact evaluator inputs rather than submission claims.
Supplied finding labels map to policy
rejections; plugin-builder does not claim to discover leakage, injection, or
deception from arbitrary content.
Asset reads compare root, ancestor, and target device/inode identities before
and after an identity-bound no-follow read. Descriptor identity, link count,
size, modification/change time, and two bounded positioned byte reads must
remain stable; transient links, in-place rewrites, multi-link files, and
detected ancestor replacement races fail closed.
Filesystem identity uses bigint `dev`, `ino`, `nlink`, `size`, `mtimeNs`, and
`ctimeNs` end to end. Runtimes without exact bigint stat fields fail closed;
there is no lossy numeric fallback.
Agent contract assets are capped at 1 MiB before allocation. Their JSON is
lexically validated before parsing, including decoded duplicate-key rejection,
so escaped and literal spellings cannot collapse into one trusted member.

## Reviewed cohesive files

Three implementations remain above the 450-line review threshold but below
the 650-line extraction threshold:

- `src/shipped-language/markdown-content.ts` owns one ordered Markdown/HTML
  security parser. Its token, tree, entity, and rendered-surface checks share
  traversal state and diagnostic ordering.
- `src/agent-contract/acceptance/evaluation.ts` owns causal acceptance-gate
  evaluation. Evidence parsing and identity validation are already separate;
  the remaining state machine keeps gate order, trusted facts, review, retry,
  and rejection precedence together.
- `src/agent-contract/evaluation/contract.ts` owns the evaluator protocol's
  strict parsing, digest, time, version, identity, and rejection primitives.
  They share the `EvaluationOptions` trust boundary and stable rejection
  vocabulary used by every evaluator.

Re-review these owners if they exceed 650 lines, acquire an independently
testable state machine or trust boundary, or require unrelated diagnostics to
change together.

Executable package sources are bundled to the four stable plugin entrypoints
plus the installer CLI. The generated bundles are dependency-self-contained
and intentionally omit package-internal module trees. Repository Biome policy
must exclude only those generated bundle destinations; each canonical source
package remains independently typechecked, tested, and formatted.
