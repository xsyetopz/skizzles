# ADR 0002: Make architecture fitness executable

- **Status:** Accepted
- **Date:** 2026-07-18
- **Decision owner:** workspace policy and package owners
- **Scope:** source ownership, manifests, imports, exports, tests, generated artifacts, and exceptions

## Context

Documentation cannot prevent private imports, cycles, hidden filesystem coupling,
source/generated inversion, or public-surface growth. The baseline already has useful
enforcement in `@skizzles/workspace-governance` and plugin parity checks, but the campaign
inventory found gaps and oversized canonical units. Fowler's evolutionary architecture
guidance and ADR practice both favor feedback and explicit rationale over periodic
inspection.

## Decision

Every authored unit must have one accountable source-tree owner, one primary reason to
change, intentional visibility, allowed dependency direction, owned tests, matching
build metadata, and a repository-toolchain verification path.

The strongest native mechanism owns each rule. TypeScript/compiler visibility and
package export maps come first; workspace policy fills semantic gaps; focused tests
prove runtime and distribution contracts. Root scripts compose package checks rather
than duplicate their logic.

Required architecture rules are:

- workspace and package dependency graphs are acyclic;
- every internal package import has a direct manifest dependency;
- sibling packages consume only public exports, never private paths or relative
  filesystem traversal;
- production source does not import tests, fixtures, generated plugin output, or
  undeclared host files;
- generated/plugin paths are leaves with deterministic freshness and hygiene checks;
- public exports and binaries have named consumers and contract tests;
- entrypoints remain composition and lifecycle owners rather than policy owners;
- tests are colocated with the package and boundary they prove;
- authored files above 450 physical lines receive cohesion review, files above 650
  receive a responsibility/extraction map, and changed canonical files above 800 are
  split unless explicitly authorized;
- alternate lockfiles, undeclared root dependencies, build-info, symlinks, machine
  paths, credentials, caches, and live state are rejected.

Checks report deterministic paths, rules, and remediation. A warning is a review
request; an error must be removed or covered by a valid exception. Generated files are
excluded from authored-size policy only when their provenance and freshness owner are
identifiable.

## Exception contract

An architecture exception is a versioned record under `docs/decisions/` or a linked,
machine-readable policy entry. It must name:

1. the exact rule and path/target scope;
2. the technical or external contract that makes compliance invalid;
3. the accountable package owner;
4. a compensating check;
5. an expiry, removal condition, or evidence-based review trigger.

`legacy`, `temporary`, framework convention, file size alone, or migration difficulty
are not sufficient reasons. Baseline findings are not grandfathered exceptions.

## Considered alternatives

- **Documentation and reviewer memory:** rejected; neither is deterministic or
  complete.
- **One giant snapshot of the tree:** rejected; it is brittle and cannot explain the
  rule being protected.
- **A new external architecture platform:** deferred; the existing Bun/TypeScript
  toolchain can own current gaps without a new dependency or service.
- **Treat all warnings as failures:** rejected; heuristics require review and generated
  artifacts can create false positives.
- **Suppress known findings globally:** rejected; exceptions must be narrow and owned.

## Consequences

- Policy changes need negative fixtures and diagnostics as well as happy-path tests.
- Structural moves include consumers, manifests, tests, docs, and generators in one
  coherent change.
- The structural audit remains a signal generator; exact dependency and runtime checks
  decide acceptance.
- Export and package growth require a named consumer and compatibility rationale.

## Fitness checks

The repository aggregate remains:

```sh
bun run workspace:check
bun run check
bun run typecheck
bun run test
bun run packages:build
bun run plugin:check
```

The architecture campaign must add focused negative cases for each newly enforced rule
and finish with zero unexplained canonical audit errors. Generated changes require a
recorded pre-build drift check, `bun run plugin:build`, a clean `bun run plugin:check`,
and generated-diff inspection. Final proof includes a no-hardlinks clean-checkout
reproduction.

## Review and supersession

Review when Bun, TypeScript, package export semantics, or the plugin format changes;
when a checker produces recurring false positives; or when a rule can move from a
custom scan into a stronger compiler/build boundary. Superseding records must preserve
or explicitly retire every protected failure mode.
