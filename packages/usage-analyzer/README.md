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
