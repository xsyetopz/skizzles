# `@skizzles/candidate-manifest`

This leaf package owns the versioned candidate file-manifest digest shared by
Skizzles assurance and orchestration packages. Use it whenever independently
produced evidence must name the same set of candidate writes and deletions.

## Public surface

The package root exports `createCandidateManifest`, `parseCandidateManifest`,
`isCandidateManifest`, and the manifest types.

`createCandidateManifest` accepts trusted typed entries and returns an
immutable canonical value. A manifest is a lexically sorted list of NFC
relative paths and candidate operations. `write` entries carry a SHA-256
content digest; `delete` entries carry `null`, so a deletion cannot be confused
with an empty file.

Use `parseCandidateManifest` or `isCandidateManifest` at untrusted boundaries.
They reject mutable structures, proxies, accessors, unknown keys, path aliases,
noncanonical entry order, and mismatched digests.

## Trust boundary

Creating a manifest does not prove where its entries or content digests came
from. The caller must establish that provenance. Public values contain only
normalized relative paths and SHA-256 digests; this package never accepts raw
file bytes or host filesystem paths and has no runtime package dependencies.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
