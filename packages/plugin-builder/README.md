# `@skizzles/plugin-builder`

Private package for deterministic Skizzles plugin staging, validation, and
generated-tree drift checks.

The package stages allowlisted workspace package files into stable plugin
destinations, validates packaged prompt policy through
`@skizzles/prompt-layer`, bundles Container Lab entrypoints, and rejects local
state, unsafe paths, symlinks, and machine-specific content. The public
entrypoint exports the staging/check/build APIs; `skizzles-plugin-builder`
provides the repository CLI.

Executable package sources are bundled to the four stable plugin entrypoints
plus the installer CLI. The generated bundles are dependency-self-contained
and intentionally omit package-internal module trees. Repository Biome policy
must exclude only those generated bundle destinations; each canonical source
package remains independently typechecked, tested, and formatted.
