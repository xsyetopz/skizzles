# ADR 0004: Gate Rust adoption on measurement and reversible parity

- **Status:** Accepted
- **Date:** 2026-07-18
- **Decision owner:** affected capability package and repository architecture
- **Scope:** native components, rewrites, FFI, and build/release topology

## Context

Skizzles is a Bun/TypeScript packaging workspace. No current requirement proves that a
Rust component would improve user-visible latency, throughput, memory, safety, binary
distribution, or reliability enough to justify a second language and toolchain.

Bun's Rust rewrite is a useful workflow case study, not transferable proof. Bun had a
535,496-line Zig runtime, recurring manual-memory stability defects, a language-neutral
TypeScript suite with roughly one million assertions, extensive platform coverage,
adversarial review, fuzzing, and an organization able to operate the new toolchain. The
article also reports known regressions and remaining `unsafe` code. Skizzles has a
different problem and risk profile.

## Decision

Rust is **deferred by default**. A proposal may proceed only through these gates:

1. **Measured problem:** reproducible profiles and representative workloads identify a
   material TypeScript/Bun bottleneck or safety failure. A target and acceptable variance
   are stated before implementation.
2. **Alternatives:** TypeScript algorithm, data-flow, I/O, Bun API, and packaging fixes
   are measured. Rust is selected only if expected value exceeds build, FFI, platform,
   security, and ownership cost.
3. **ADR and owner:** a superseding or scoped ADR names the capability owner, public
   language-neutral contract, supported platforms, toolchain/lock authority, artifact
   provenance, vulnerability process, and removal trigger.
4. **Pilot:** a bounded native leaf or adapter proves the bottleneck without moving
   policy out of the TypeScript capability owner.
5. **Parity:** the same black-box contract suite runs against old and candidate
   implementations, including errors, cancellation, cleanup, malformed input, and
   platform behavior. Candidate-only tests are not parity proof.
6. **Benchmarks:** cold/warm startup, throughput, latency distribution, memory, binary
   size, build time, and package/install impact are measured on supported platforms.
7. **Safety:** FFI allocation, ownership, panic/error mapping, threading, cancellation,
   and `unsafe` scope are reviewed and fuzzed where input parsing warrants it.
8. **Rollout and rollback:** the old path remains selectable only for a bounded trial;
   acceptance removes displaced code and dual authority. Rollback restores one coherent
   implementation and generated output.
9. **Clean reproduction:** CI and a no-hardlinks clean checkout build, test, package,
   and verify the native artifact without undeclared host state.

Rust never becomes an ambient `core`, a place to hide oversized TypeScript, or a second
owner for plugin/prompt policy.

## Considered alternatives

- **No Rust under any circumstance:** rejected; a measured native need may arise.
- **Immediate broad rewrite modeled on Bun:** rejected; Skizzles lacks the same measured
  defect class, scale, and parity harness.
- **Keep TypeScript and Rust implementations indefinitely:** rejected; dual authority
  multiplies tests, drift, packaging, and security work.
- **Native microservice:** rejected; a process/network boundary adds failure modes and is
  not justified by local performance alone.
- **Rewrite oversized files in Rust:** rejected; cohesion and language selection are
  separate decisions.

## Consequences

- Current refactoring remains in strict erasable TypeScript.
- A Rust experiment carries its own measurement and removal cost; enthusiasm or catalog
  examples are not admission evidence.
- Any accepted native leaf expands release, SBOM/license, cross-platform, caching, and
  clean-build ownership.
- Displaced TypeScript is removed after parity acceptance; compatibility is preserved at
  the language-neutral public contract.

## Fitness checks

A Rust proposal must provide reproducible benchmark commands and raw results, the shared
black-box parity suite, `cargo fmt --check`, locked build/check/test commands, dependency
and license review, fuzz/sanitizer evidence appropriate to the boundary, supported-
platform CI, plugin packaging/parity, and clean-checkout reproduction. Thresholds belong
in the proposal ADR because no current baseline justifies universal numbers.

## Review and supersession

Review when profiles identify a material native candidate, Bun removes the relevant
bottleneck, supported platforms change, or the native owner can no longer maintain the
toolchain. Supersede this ADR before adding `Cargo.toml`, Rust source, native build
artifacts, or FFI to the workspace.

## Evidence updates

- [2026-07-18 Rust measurement gate](../../research/rust/measurement-gate.md):
  concurrent-tree triage found lifecycle, process, filesystem, and deliberate-wait
  costs rather than a qualifying CPU-bound boundary. It records the reproducible
  revisit threshold and native-pilot evidence contract.
