# ADR 0008: Parse TypeScript source dependencies with the compiler AST

- **Status:** Accepted
- **Date:** 2026-07-19
- **Decision owner:** `@skizzles/workspace-governance`
- **Scope:** TypeScript source dependency discovery and parser lifecycle

## Context and evidence

Workspace policy must classify literal module edges in `.ts`, `.tsx`, `.mts`, and
`.cts` files. Bun's `Transpiler.scanImports` is the existing syntax and runtime or
dynamic-import boundary, but it omits erased type-only declarations. The supplemental
handwritten scanner consequently had to distinguish division from regular expressions
while approximating TypeScript declarations. Historical bypasses included numeric,
postfix, generic, template-interpolation, keyword-member, nested class-heritage,
`as const`, interface, and decorator contexts. Extending lexical state for each grammar
interaction reproduced parser responsibility without a parser's grammar authority.

The installed TypeScript 7.0.2 package exposes an asynchronous compiler API at
`typescript/unstable/async` and AST nodes and guards at
`typescript/unstable/ast`. A Bun/macOS-arm64 probe opened an inferred project, returned
source files and syntactic diagnostics, extracted import declarations, export
declarations, import type nodes, and external import-equals references, then disposed
the snapshot and closed the API without retaining a `tsgo --api` process. The
synchronous unstable API crashed under Bun during boundary triage and is not an
eligible fallback.

The asynchronous client spawns TypeScript's bundled native `tsgo` executable. The
`typescript` package declares platform-specific optional packages. macOS arm64 is
verified locally; clean-checkout Linux proof remains a final release gate rather than
an inference from the local result.

## Decision

Use one asynchronous TypeScript API and one snapshot for each workspace validation.
Open every eligible authored source file in that snapshot, obtain its default project,
reject its syntactic diagnostics, obtain its program source file, and traverse the
materialized AST synchronously. Extract only literal specifiers from:

- `ImportDeclaration`, including declaration-level and inline type imports;
- `ExportDeclaration`, including type exports;
- `ImportTypeNode` with a string literal argument;
- `ImportEqualsDeclaration` with a string external-module reference.

Continue to run Bun `Transpiler.scanImports` for runtime and dynamic import behavior.
Sort and deduplicate the union before applying extension, ownership, dependency,
private-export, and local-SCC policy. Comments, ordinary strings, templates, regular
expressions, JSX text, and JSDoc are not declaration edges.

Backend, source-file, syntactic-diagnostic, snapshot-disposal, and API-close failures
produce `source-parse-error`; no lexical or partial-success fallback is permitted.
Dispose the snapshot before closing the API, and discard otherwise successful results
when backend lifecycle cleanup fails.

Retain the exact discovered bytes as A before opening the snapshot. TypeScript reopens
the owned paths and parses its observed generation. After snapshot disposal and API
close, reread every path as exact bytes B before running Bun or combining AST results.
Require B to equal A byte-for-byte. A mismatch or reread failure produces a
deterministic per-file `source-parse-error`, and that file contributes no package-policy
or SCC edge. This is an A/TypeScript/B stable-read bracket for trusted projects, not an
atomic filesystem snapshot.

Make exact TypeScript 7.0.2 a runtime dependency of workspace policy. Bun builds externalize
`typescript` and `typescript/*`, so built CLI and policy entrypoints resolve the
installed package and its native platform binary rather than embedding unstable client
internals or machine-specific paths.

## Alternatives considered

- **Continue the handwritten lexer:** rejected. Each bypass correction expanded a
  second grammar and left materially different contexts available for recurrence.
- **Use Bun alone:** rejected because type-only static edges disappear before
  `scanImports`, removing dependency, private-surface, and SCC evidence.
- **Use TypeScript's synchronous unstable API:** rejected because the Bun runtime probe
  crashed; using it would make the validator unavailable rather than fail closed.
- **Bundle TypeScript or locate `tsgo` through private paths:** rejected. Either couples
  the artifact to unstable implementation internals or risks embedding a
  machine-specific native path.
- **Create one parser process per file:** rejected because repeated native startup adds
  avoidable latency and complicates complete lifecycle cleanup.

## Consequences and limitations

Source dependency classification now follows TypeScript's parser rather than local
lexical heuristics, and all historical bypass cases become ordinary grammar inputs.
The four explicit static forms and Bun's dynamic scan remain independently visible.
Parser startup adds one native subprocess per validation, so focused source-policy
tests are slower than an in-process lexer but reuse a single snapshot across all files.

The API and AST entrypoints are explicitly unstable. TypeScript remains responsible
for shipping a native package for each supported host. Workspace policy does not
resolve `tsconfig` path aliases, infer nonliteral specifiers, or perform semantic type
checking. Platform availability, upstream optional-package ownership, and executable
startup are operational prerequisites, not behavior proven by AST tests.
The stable-read bracket detects ordinary edits that remain visible at B, but a hostile
same-user ABA rewrite can present another generation to TypeScript and restore exact A
before B. Excluding that race would require an immutable filesystem snapshot or a
parser API that accepts the already-read source bytes.

## Fitness checks

```sh
bun test packages/workspace-governance/test/workspace/source-imports.test.ts
bun run --cwd packages/workspace-governance typecheck
bun run --cwd packages/workspace-governance check
bun run --cwd packages/workspace-governance build
bun packages/workspace-governance/dist/cli.js .
bun -e 'import("./packages/workspace-governance/dist/workspace/policy.js")'
bun install --frozen-lockfile
bun run workspace:check
```

Regression tests bind every historical bypass, the four static forms, inert syntax,
TSX/MTS/CTS, syntax rejection, deterministic deduplication, backend and cleanup
failure, local SCCs, private imports, and undeclared dependencies. Release acceptance
must repeat build/runtime and frozen-install checks from a clean checkout on Linux.

## Review and supersession

Review on every TypeScript upgrade, unstable API or AST shape change, Bun upgrade,
new supported operating system or CPU, missing optional native package, parser startup
or cleanup regression, source-policy performance regression, or newly supported module
syntax. The workspace-governance owner owns API/build behavior; release reviewers own the
clean Linux proof and any supported-platform expansion. Supersede this ADR before
changing parser authority, adopting semantic resolution, bundling TypeScript, or
introducing a fallback scanner. Supersession must remove this parser and its dependency,
tests, build exclusions, and documentation together rather than retaining a legacy path.
