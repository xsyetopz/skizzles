# @skizzles/usage-analyzer

Private, read-only Codex rollout usage analyzer.

Invoke the package-owned script from the source workspace:

```sh
bun run packages/usage-analyzer/src/main.ts --from 2026-07-01
```

Generated plugins expose the dependency-self-contained `scripts/analyze.ts`
runtime path.

It reads rollout files in `$CODEX_HOME` (or `$HOME/.codex`) and optionally the
newest `state_*.sqlite` title index. It does not modify those inputs. The
comparison proxy is aggregate-only and is not quota or billing data.

## Routing experiments

The package also exposes a strict in-memory routing learner from its public
entrypoint. Hosts provide candidate metadata (including optional AAII/price
priors), task strata, randomized assignment evidence, per-stage usage,
measured coordination overhead, and independently verified outcomes:

```ts
import {
  RoutingLearner,
  parseRoutingCandidate,
  parseRoutingObservation,
  parseRoutingTaskProfile,
} from "@skizzles/usage-analyzer";
```

Recommendations are stratified and remain unavailable until configured sample
and Wilson lower-bound verification gates pass. Observations require task/run,
receipt, dispatch, stage, disjoint token-ledger, propensity, and independent
verification joins. The learner does not select a model endpoint, persist to
`$CODEX_HOME`, or treat AAII/price metadata as a route policy. See
[Fourth Wall routing guidance](../../skills/fourth-wall/references/routing-learning.md).
