# `@skizzles/change-assurance`

`@skizzles/change-assurance` owns host-declared, pre-publication assurance for
source changes. It binds exact immutable baseline and candidate bytes to four
independent assurance domains and emits an authentic digest-only receipt.

The public workflow is:

1. A trusted host creates an authentic change declaration with exact targets
   and structured plans for every assurance domain.
2. The host configures one extension from each dedicated domain factory and
   constructs a `ChangeAssurance` facade. Generic extension registration is
   package-internal and cannot be supplied by public callers.
3. `ChangeAssurance.assess(unknown)` validates exact input shape and byte
   immutability, invokes every extension, and returns a receipt with no source
   bytes or declaration plans.

Method copies, hand-built declarations, missing domains, mutable byte arrays,
target drift, extension exceptions, and malformed extension results fail
closed.
