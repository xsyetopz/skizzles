---
name: cargo-build-optimize
description: Profile and reduce Rust/Cargo build times through measured, behavior-preserving optimization campaigns. Use when a Rust workspace has slow cold builds, slow warm rebuilds, giant crates, duplicate dependencies, expensive macros/codegen, poor Cargo parallelism, or when asked to apply the fasterthanli.me Rust build profiling methodology, split crates for build speed, inspect cargo timings, or run a long-running /goal-driven build optimization effort.
---

# Cargo build optimization

Profile and reduce Rust build latency without changing behavior. This skill is for maintainers working on slow Cargo edit loops, cold builds, duplicate dependencies, large local crates, macro or codegen cost, linking, and poor compilation parallelism.

## Prerequisites

- Identify the command whose latency affects daily work.
- Preserve the repository's required build environment, feature flags, and command wrappers.
- Start from a state where the representative command can be run repeatedly.
- Separate cold-build measurements from warm edit-and-rebuild measurements.

Every change must produce a comparable before/after signal. Prefer one small structural slice at a time.

## Campaign goal

For long-running work, set or ask the agent to set a `/goal` for the full campaign, not for the current slice.

Use this goal shape:

```text
Reduce Rust build latency by iteratively improving compilation-unit structure.
1. Fix obvious dependency duplication.
2. Extract support crates before route/application crates.
3. Extract one vertical slice and evaluate.
4. Repeat for the next largest neighborhoods until returns diminish.
```

The active implementation should still be one small slice at a time. When a slice is complete, report the result and continue to the next slice if the campaign goal is not achieved.

Do not reduce the goal to "extract this helper"; that loses the campaign objective. Do not use "optimize all builds" without an ordered campaign and measurable stopping criteria.

## Measurement loop

1. Establish the narrowest direct command that represents the painful build path.
2. Capture a baseline with `--timings` when practical.
3. Classify the bottleneck: one giant local crate, duplicate dependencies, expensive macros, monomorphization/codegen, linking, or poor parallelism.
4. Pick exactly one behavior-preserving slice.
5. Make the smallest structural change that creates a better compilation boundary.
6. Run direct validation for changed crates first, then the representative command.
7. Capture a new timing report and compare against the baseline.
8. Summarize the delta, remaining bottleneck, and next slice.

Start with a direct Cargo command when it proves the same build surface faster than a broad harness, full-stack script, or CI-equivalent command.

## Baseline commands

Start with commands like these, adjusted to the workspace:

```sh
cargo check -p <package> --features <features> --timings
cargo test -p <changed-helper-crate>
cargo tree -p <package> --features <features> -e normal,build -d
```

When compile-time database or service checks exist, preserve the project's normal build environment:

```sh
SQLX_OFFLINE=true cargo check -p api --bin api --features blob-s3 --timings
```

Cargo timing reports land under:

```text
target/cargo-timings/
```

Compare warm rebuilds separately from cold builds. A project can have acceptable cold builds but terrible edit/test loops, or the reverse.

## Choosing a slice

Prefer slices that meet these conditions:

- Duplicated across routes, services, domains, or crates.
- Behavior is boring enough to preserve exactly.
- Ownership belongs in an existing support crate or a clearly named new crate.
- Old local code can be deleted rather than wrapped.
- Validation is direct and repeatable.

Typical candidates:

- Route-local validation helpers.
- Repeated response builders.
- Repeated projection/query error mappers.
- Shared DTO/view/model surfaces trapped in a giant binary or application crate.
- Domain/rule/contract code mixed into route handlers.
- Vertical route neighborhoods after support/domain code has already been extracted.

Avoid:

- Sweeping rewrites that cannot be attributed to one timing delta.
- Compatibility shims around moved helpers.
- Moving dead code into new crates.
- Docs-only declarations of future splits.
- Feature-gate contortions unless measurement shows they help.

## Crate-splitting order

Crate splitting also improves measurement. A large crate hides its cost centers behind one Cargo timing bar. Smaller crates let Cargo reuse stable units and make later timing reports easier to interpret.

Extract in this order when possible:

1. Generic support/helpers used by many modules.
2. DTO/view/model types with little runtime behavior.
3. Domain/rule/contract logic.
4. One vertical route/application slice.

Prefer support crates before route crates. A route crate extraction is easier and safer after helpers, view types, and domain contracts stop living inside the monolith.

## Macro and codegen checks

If `cargo --timings` only says one local crate is expensive, use deeper tools before guessing:

```sh
cargo +nightly rustc -p <package> -- -Z self-profile
summarize <profile-file>
flamegraph <profile-file>
cargo llvm-lines -p <package>
```

Investigate:

- SQLx, Diesel, serde, router, or other heavy macro expansion.
- Route combinators or builder APIs producing huge generic types.
- A small number of symbols dominating LLVM IR.
- Repeated monomorphization caused by generic helpers that could be boxed, erased, or moved.

For SQLx-heavy dev builds, consider a measured profile override:

```toml
[profile.dev.package.sqlx-macros]
opt-level = 3
```

Only keep profile changes when they improve the representative command.

## Verification and reporting

For every slice, report:

```text
Slice:
Changed:
Validation:
Timing before:
Timing after:
Timing report:
Deleted old code:
Remaining bottleneck:
Next slice:
```

Validation should usually include:

```sh
cargo fmt -p <changed-crate> -p <main-crate>
cargo test -p <changed-helper-crate>
cargo check -p <main-crate> --features <features>
cargo check -p <main-crate> --features <features> --timings
git diff --check
```

Adjust commands to the repository's own conventions. If the repo forbids direct `cargo test` or requires `just`, follow the repo instructions.

## Boundaries

- Preserve runtime behavior and public contracts unless the user separately authorizes a functional change.
- Delete old local implementations after extraction. Do not leave wrappers or compatibility copies.
- Keep timing artifacts out of source control unless the repository explicitly tracks them.
- Do not keep a profile override, feature change, boxing decision, or new crate without a measured benefit on the representative command.
- Follow repository instructions when they replace direct Cargo commands with `just` or another wrapper.

## Completion criteria

A slice is complete when:

- Behavior is preserved.
- Old local duplicates are removed.
- The narrow validation command passes or the blocker is clearly isolated.
- Timing was captured or a specific reason explains why not.
- The next slice is identified if the broader `/goal` remains open.

The campaign is complete when timing returns diminish, the original painful edit loop is acceptable, or the remaining bottleneck is outside the local code structure being optimized.
