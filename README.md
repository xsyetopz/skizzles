# Skizzles

![Skizzles logo](packages/plugin-packaging/template/assets/logo.png)

Skizzles is a portable set of skills, hooks, and developer tools for Codex.
This repository is the source workspace; `plugins/skizzles/` is the generated
plugin that Codex installs.

## Install the plugin

The normal path is one command from a checkout. You need:

- Codex CLI with the `codex plugin` commands;
- [Just](https://github.com/casey/just) to run the repository commands; and
- Bun available on `PATH` for Skizzles' bundled hooks and runtime tools.

Clone the repository, then install it into an existing Codex home:

```sh
git clone https://github.com/xsyetopz/skizzles.git
cd skizzles
just plugin-install "$HOME/.codex"
```

The command adds this checkout as the `skizzles` marketplace and installs
`skizzles@skizzles`. It changes only the Codex home you pass as the first
argument. Use a disposable existing directory when trying Skizzles for the
first time. To use another Codex binary, set `CODEX_BIN=/absolute/path/to/codex`.
When using a local source, pass the repository root; Codex reads its marketplace
metadata from `.agents/plugins/marketplace.json`.

Start a new Codex task after installation so the cached plugin is discovered.
The generated plugin is self-contained, but its executable hook and runtime
entrypoints still require Bun.

If you do not want a checkout, the equivalent official Codex CLI flow is to add
the Git repository as a marketplace and then add `skizzles@skizzles`:

```sh
codex plugin marketplace add xsyetopz/skizzles
codex plugin add skizzles@skizzles
```

See the
Codex [plugin](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-plugin)
and [marketplace](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-plugin-marketplace)
command reference for the current syntax.

Useful lifecycle commands from a checkout:

```sh
just plugin-status "$HOME/.codex"
just plugin-remove "$HOME/.codex"
```

Removal deletes the installed `skizzles@skizzles` cache entry first and then
removes the configured `skizzles` marketplace. Review `plugin-status` before
removing anything from a shared Codex home.

## Skills only

Choose this when you want Skizzles guidance without hooks or bundled runtime
tools:

```sh
just skills-install
```

This uses the Skills CLI to install the public `install-skizzles` skill. The
full plugin remains the recommended option when you want the complete bundle.

## Source development

The workspace uses Bun and keeps one lockfile at the repository root:

```sh
just setup
just verify
```

Maintainer shortcuts are available through the same `justfile`:

```sh
just plugin-build   # rebuild plugins/skizzles from canonical inputs
just plugin-check   # prove generated output is in sync
```

Never edit `plugins/skizzles/` by hand. Change canonical package or skill
inputs, run `just plugin-build`, inspect the generated diff, and finish with
`just plugin-check`.

## What is included

- reusable Codex skills, including Fourth Wall orchestration guidance;
- a command-output hook and bounded command supervisor;
- disposable Docker Compose Container Lab tooling;
- privacy-preserving rollout usage analysis;
- a validated model-catalog overlay with explicit host activation; and
- reversible configuration and prompt-policy lifecycles for advanced setups.

The production implementation is split into capability packages under
`packages/`. See [workspace architecture](docs/workspace-architecture.md) for
package ownership and generated-artifact boundaries.

## Advanced setup

The public [`install-skizzles`](skills/install-skizzles/SKILL.md) skill covers
source-linked development installs, Codex configuration, prompt policy, and
diagnostics. Those lifecycles are separate from the official Codex
plugin/marketplace flow and are not required for a normal plugin install.

Container Lab host wiring and the optional model-catalog LaunchAgent are also
explicit, reversible machine setup. Read their owning guides only when you
need those features:

- [Container Lab installation](packages/container-lab/docs/installation.md)
- [Model catalog installation](packages/model-catalog/docs/installation.md)

Ordinary plugin or skill installation does not modify `PATH`, launchd, Docker,
or active Container Lab state.
