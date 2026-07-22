# `@skizzles/candidate-manifest`

The sole canonical owner of a versioned candidate file-manifest digest. A
manifest is an immutable, lexically sorted list of NFC relative paths and their
candidate operations. `write` entries carry a SHA-256 content digest; `delete`
entries explicitly carry `null`, so deletion cannot be confused with an empty
file.

`createCandidateManifest` accepts trusted, typed entry data and returns a
canonical immutable value. It is not an authenticity assertion: callers still
need to establish where content digests and entries came from. Use
`parseCandidateManifest` or `isCandidateManifest` at an untrusted boundary;
they reject mutable structures, proxies, accessors, unknown keys, path aliases,
non-canonical entry order, and a mismatched digest.

Receipts expose only normalized relative paths and SHA-256 digests. This package
never accepts raw file bytes or host filesystem paths.
