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
package uses Bun, Node built-ins, and the public prompt-layer and Container Lab
contracts at runtime. Prompt-policy source discovery consumes the prompt-layer
provider's canonical and packaged descriptor locations; it does not traverse a
sibling package's private filesystem layout. Portable staged plugin roots keep
the stable `integrations/`, `instructions/`, and `third_party/` artifact shape.
