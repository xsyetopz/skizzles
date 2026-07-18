# Rust measurement gate — 2026-07-18

This is the dated evidence update for [ADR 0004](../decisions/0004-measurement-gated-rust.md),
not an acceptance benchmark or a Rust implementation proposal. The decision is **defer
Rust and reject a pilot now**: no measured owner is shown to be a CPU-bound native
candidate.

## Environment and method

- Host: macOS 15.7.7 (24G720), Apple M1 Max / arm64.
- Runtimes: Bun 1.3.14; Homebrew `rustc` 1.97.0 and `cargo` 1.97.0.
- Test method: three sequential warm invocations of
  `/usr/bin/time -p bun test packages/<package>/test`; median and inclusive wall-time
  range below are from successful repetitions.
- Compile method: package `typecheck` and `bun build <entries> --target=bun
  --outdir=/tmp/skizzles-rust-gate-build/<package>` with output redirected outside the
  repository. Build results have three warm repetitions; typecheck records have two
  successful warm repetitions.
- Startup method: executable `--help` commands, measured in milliseconds; exit status
  reflects each CLI's existing usage contract rather than a new requirement.

The repository changed concurrently. One plugin-builder test repetition failed while
the agent-contract staging inputs were changing; its two later repetitions passed. The
then-current `plugin:check` also reported expected generated-output drift. Therefore,
these are triage gate measurements, not frozen-commit acceptance benchmarks. The raw
session artifacts were retained only under `/tmp` and are deliberately not durable
evidence paths.

## Measurements

### Package test wall time

| Package owner | Successful warm reps | Median | Range |
| --- | ---: | ---: | ---: |
| installer | 3 | 12.631s | 12.341–12.921s |
| plugin-builder | 2 | 12.590s | 11.912–13.268s |
| container-lab | 3 | 9.241s | 9.207–9.270s |
| command-supervisor | 3 | 6.364s | 6.174–6.432s |
| model-catalog | 3 | 5.393s | 5.379–5.395s |
| workspace-policy | 3 | 4.258s | 4.085–4.303s |
| prompt-layer | 3 | 2.953s | 2.638–2.975s |
| command-hook | 3 | 2.014s | 1.914–2.228s |
| usage-analyzer | 3 | 0.419s | 0.389–0.438s |

Typecheck medians/ranges were 80–114ms across the nine package owners; Bun-build
medians/ranges were 8–17ms. CLI help/startup medians/ranges were 21–43ms: command
supervisor 22.70ms (21.88–30.28), Container Lab 42.42ms (42.11–44.15), reaper
42.72ms (41.97–43.55), installer 26.21ms (25.67–27.87), model catalog 21.45ms
(20.88–22.32), plugin builder 25.10ms (24.84–26.31), prompt layer 22.46ms
(22.14–22.71), usage analyzer 21.97ms (21.84–22.79), and workspace policy 21.34ms
(21.04–21.66). Bundle sizes ranged from 11KB to 0.43MB.

For repository checks, `workspace:check` had a 0.445s median (0.437–0.451s), strict
architecture fitness 0.444s (0.441–0.474s), and `prompt:check` 0.068s
(0.068–0.069s). These are Bun/TypeScript workflow measurements, not a comparison with
a native implementation.

## Causal classification and TypeScript/Bun-first work

The longer test owners do not establish a CPU bottleneck:

- Installer time includes intentional child-process lifecycle handling; the app-server
  `ConfigRpc.close()` path includes a two-second graceful-shutdown window.
- Plugin builder is staging/tree comparison/recursive filesystem copy and spawned-Bun
  smoke work; measured system time exceeds user time.
- Container Lab is process-group cleanup, timeout behaviour, filesystem sync, and
  mocked Docker boundaries; real Docker, build, and network costs are external.
- Command supervisor's atomic-snapshot coverage deliberately launches 240 query
  subprocesses, makes 1,000 direct status reads, and includes 160 sleeps.
- Model catalog exercises child termination plus cache/filesystem handling; workspace
  policy deliberately has one-second containment deadlines.
- Usage analyzer is the only plausible future computational leaf (read-only JSONL
  parsing and aggregation), but is currently the fastest suite and has no representative
  large-rollout profile. Its CLI, discovery, SQLite access, and reporting policy remain
  TypeScript-owned.

Before reconsidering Rust, measure and, where contractually safe, improve the
installer graceful-close policy; batch installer wire-code cases or move most to
parser-level tests while retaining causal CLI smokes; reuse staged plugin fixtures;
and move most command-status atomicity coverage in-process while retaining bounded
entrypoint coverage. Intentional waits and process cleanup must not be relabeled as
native compute demand.

## Revisit gate and pilot contract

Reconsider only on a frozen commit with a representative production workload, five
cold and twenty warm repetitions on every declared supported OS/architecture. One
deterministic in-process owner must, in three independent profiles and excluding Docker,
network, intentional waits, and child-process latency:

1. account for at least 50% of end-to-end wall time;
2. have p95 at least 2.0s or at least 1.0 CPU-second per invocation; and
3. still breach its stated SLO after measured TypeScript algorithm, data-flow, I/O, and
   Bun optimizations.

A recurring memory-safety defect class independently triggers review. A later pilot
must forecast at least 2x owner throughput, 30% end-to-end p95 improvement, no more
than 10% RSS regression, no more than 50ms cold-start regression, and explicit build,
binary, and packaging budgets.

Before any pilot, the repository must declare supported platforms and add a scoped ADR
covering a versioned language-neutral contract; exact outputs/errors/exit codes,
permissions, containment, links, atomicity, idempotency, cancellation, signals,
concurrency, and cleanup; unchanged black-box parity tests; cold/warm p50/p95/p99,
throughput, CPU, RSS, binary, build, install, and plugin-package evidence; locked
Cargo/provenance/SBOM/license/vulnerability and `unsafe` review; parser-appropriate
fuzzing; platform CI; and a bounded feature-gated rollback that restores a single
TypeScript authority and removes native artifacts.
