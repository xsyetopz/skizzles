# `@skizzles/usage-analysis`

This private package has two read-only tools: a Codex rollout usage analyzer
and an in-memory routing-experiment learner. Use the analyzer for local rollout
comparisons, and use the learner only with randomized assignment evidence and
independently verified outcomes.

## Rollout analyzer

Run the package-owned script from the source workspace:

```sh
bun run packages/usage-analysis/src/main.ts --from 2026-07-01
```

Generated plugins expose the dependency-self-contained
`scripts/analyze.ts` path. The analyzer reads rollout files in `$CODEX_HOME` or
`$HOME/.codex` and may read the newest `state_*.sqlite` title index. It never
modifies those inputs. Its comparison proxy is aggregate-only and is neither
quota nor billing data.

## Routing learner

The package root exports `run`, `RoutingLearner`, its strict parsers, and the
routing observation and report types:

```ts
import {
  RoutingLearner,
  parseRoutingCandidate,
  parseRoutingObservation,
  parseRoutingTaskProfile,
} from "@skizzles/usage-analysis";
```

Hosts supply candidate metadata, task strata, randomized assignment evidence,
per-stage usage, measured coordination overhead, and independent verification.
Recommendations remain stratified and unavailable until the configured sample
and Wilson lower-bound verification gates pass. Every observation must join
task/run, receipt, dispatch, stage, disjoint token ledger, propensity, and
independent verification evidence.

The learner does not choose a model endpoint, persist to `$CODEX_HOME`, or
treat AAII or price metadata as routing policy. See the
[Fourth Wall routing guidance](../../skills/fourth-wall/references/routing-learning.md)
for the experiment contract.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
