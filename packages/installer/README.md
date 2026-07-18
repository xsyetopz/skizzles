# `@skizzles/installer`

Private Bun/TypeScript package that owns the Skizzles installer CLI and its
fail-closed install, uninstall, configuration, prompt-policy, and doctor
lifecycles.

## Entrypoint

The package exports and installs one executable entrypoint:

```sh
bun packages/installer/src/cli.ts --help
# or, through the workspace bin
skizzles-installer --help
```

Every stateful command requires explicit target roots. `--dry-run` uses
disposable preview state where supported and never authorizes ambient
`HOME`/`CODEX_HOME` mutation.

## Development

```sh
bun run typecheck
bun run test
bun run check
bun run build
```

Production code is under `src/`; package-owned tests are under `test/`. The
package uses only Bun and Node built-ins at runtime. Prompt inputs are read
from the canonical `packages/prompt-layer/assets/` layout in this repository
or from their stable staged plugin destinations.
