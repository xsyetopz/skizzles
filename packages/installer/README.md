# `@skizzles/installer`

This private Bun/TypeScript package owns the Skizzles installer CLI. Use it for
explicit install, uninstall, configuration, prompt-policy, and doctor
lifecycles. Repository development and plugin packaging consume the same
canonical entrypoint.

## Entrypoint

The package export is `src/cli.ts`, which exports `main` and
`exitCodeForError`. Run the CLI from the repository with:

```sh
bun packages/installer/src/cli.ts --help
```

Generated plugins keep the stable bundled
`packages/installer/src/cli.ts` path. This workspace package does not publish a
package-manager binary.

Every stateful command requires explicit target roots. `--dry-run` uses
disposable preview state where supported and never authorizes mutation of an
ambient `HOME` or `CODEX_HOME`.

## Package boundaries

Production code is under `src/`; tests are under `test/`. Runtime dependencies
are [`@skizzles/container-lab`](../container-lab/README.md),
[`@skizzles/prompt-policy`](../prompt-policy/README.md), and
[`@skizzles/scratchspace`](../scratchspace/README.md), plus Bun and Node
built-ins.

Prompt-policy discovery uses the provider's canonical and packaged descriptor
locations; it does not traverse a sibling package's private filesystem layout.
Portable staged plugin roots keep the stable `integrations/`, `instructions/`,
and `third_party/` artifact shape.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
