# `@skizzles/change-assurance`

This package owns host-declared, pre-publication assurance for source changes.
Engineering and orchestration hosts use it after exact baseline and candidate
bytes exist, but before a candidate can reach publication.

## Assessment workflow

1. A trusted host creates an authentic change declaration with exact targets
   and a structured plan for each assurance domain.
2. The host selects one extension from every dedicated domain factory and
   constructs a `ChangeAssurance` facade. Public callers cannot register a
   generic extension.
3. `ChangeAssurance.assess(unknown)` validates the complete input and byte
   immutability, invokes every extension, and returns a digest-only receipt.

The package root exports the declaration and facade factories, domain-specific
authorities and parsers, public types, and receipt guards. The receipt binds the
four independent assurance domains to exact immutable bytes. It retains the
native aggregate candidate digest and a canonical candidate-manifest digest
derived from the target paths, operations, and candidate bytes.

Method copies, hand-built declarations, missing domains, mutable byte arrays,
target drift, extension exceptions, and malformed extension results fail
closed.

## Security review boundary

The security-review surface is a second, independently branded gate over an
accepted assurance result. A host-bound `SecurityPolicyLinterAuthority`
performs semantic AST and dataflow analysis over the same candidate bytes. A
distinct `IndependentSecurityReviewAuthority` verifies the assurance, policy,
candidate, and linter receipt bindings before it can issue its receipt.

Both security receipts bind the canonical candidate-manifest digest from
[`@skizzles/candidate-manifest`](../candidate-manifest/README.md). Every high,
critical, integrity, parser, or unresolved-security finding stops assessment;
there is no waiver or suppression API.

The package also depends on [`@skizzles/scratchspace`](../scratchspace/README.md)
for bounded temporary work and on TypeScript 7.0.2 for source analysis.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
