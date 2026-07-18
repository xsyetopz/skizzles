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

- `src/plugin-package.ts` is the stable public API and executable composition
  root.
- `src/plugin/` owns canonical input declarations, deterministic staging,
  bundle creation, distribution validation, and tree comparison.
- `src/prompt-policy-package.ts` is the package-internal prompt-policy staging
  facade; `src/prompt-policy/` owns its contract parsing, containment, layout,
  and packaged-surface validation.
- `src/container-lab-package.ts` owns the Container Lab distribution contract.
- `src/agent-contract/` pins exact published Fourth Wall and Completion
  Contract schema bytes, strictly parses/evaluates contract instances, executes
  every materialized public incident regression, rejects symlinked asset paths,
  and proves staged copies are byte-identical to their canonical skill owners.
- `test/` follows those capabilities; `plugin-package-fixture.ts` is the single
  canonical isolated-workspace fixture builder.

The manifest declares every workspace package whose canonical entrypoint is
composed into the distribution. Internal implementation modules are not
package exports.

The schema-byte digests in `src/agent-contract/contract.ts` are the plugin
composition authority and must change atomically with a deliberate published
schema revision. Plugin-builder does not claim to be a general JSON Schema
meta-validator. The typed evaluators own repository acceptance semantics that
JSON Schema cannot express, using explicit clock/version/digest options and
trusted harness facts.

Executable package sources are bundled to the four stable plugin entrypoints
plus the installer CLI. The generated bundles are dependency-self-contained
and intentionally omit package-internal module trees. Repository Biome policy
must exclude only those generated bundle destinations; each canonical source
package remains independently typechecked, tested, and formatted.
