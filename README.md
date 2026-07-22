# Skizzles

![Skizzles logo](packages/plugin-packaging/template/assets/logo.png)

Skizzles is a portable toolkit for Codex. It bundles public skills, guarded
hooks, and small runtime tools that help agents work through repository changes
with explicit ownership and local evidence.

This repository is the source workspace. Codex installs the generated plugin at
`plugins/skizzles/`; that directory is build output, not an editing surface.

## Choose a starting point

### Install the complete plugin

Use this path when you want the skills, hooks, and bundled runtimes together.

Requirements:

- Codex CLI with the `codex plugin` commands;
- [Just](https://github.com/casey/just); and
- Bun on `PATH` for Skizzles hooks and runtime tools.

From a checkout:

```sh
git clone https://github.com/xsyetopz/skizzles.git
cd skizzles
just plugin-install "$HOME/.codex"
```

The command registers this checkout as the `skizzles` marketplace and installs
`skizzles@skizzles` into the Codex home you provide. Use a disposable existing
Codex home for a first trial. Set `CODEX_BIN` when the Codex executable is not
on the default `PATH`.

Start a new Codex task after installation so it can load the plugin. The
generated plugin is self-contained, but its executable hooks and runtimes still
need Bun.

The official marketplace flow does the same without a local checkout:

```sh
codex plugin marketplace add xsyetopz/skizzles
codex plugin add skizzles@skizzles
```

Read the Codex [plugin](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-plugin)
and [marketplace](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-plugin-marketplace)
references for the current CLI syntax.

Check or remove a checkout-based installation with:

```sh
just plugin-status "$HOME/.codex"
just plugin-remove "$HOME/.codex"
```

Review `plugin-status` before removing a marketplace shared by other work.

### Install the skills only

Choose this path when you want Skizzles guidance without hooks or bundled
runtimes:

```sh
just skills-install
```

This installs the public `install-skizzles` skill through the Skills CLI. Use
the complete plugin when you need the runtime bundle as well.

### Work on the source workspace

Use Bun and the one lockfile at the repository root:

```sh
just setup
just verify
```

The source tree is a Bun/TypeScript workspace. Each package owns its manifest,
source, tests, direct dependencies, and public entrypoints. The package map and
generated-artifact boundaries are documented in
[workspace architecture](docs/workspace-architecture.md).

## What Skizzles provides

The bundle covers a few separate jobs:

- public skills for agent workflows and repository policy;
- a command-output hook and bounded command observation;
- disposable Docker Compose workspaces through Container Lab;
- privacy-preserving rollout usage analysis;
- a model catalog that requires explicit host activation; and
- reversible prompt-policy and configuration lifecycles.

Install only the feature you need. The optional host integrations below are
separate from ordinary plugin installation.

## Optional integrations

Read these guides only when you are using the corresponding feature:

- [Container Lab installation](packages/container-lab/docs/installation.md)
- [Model catalog installation](packages/model-catalog/docs/installation.md)
- [`install-skizzles` skill](skills/install-skizzles/SKILL.md) for source-linked
  installs, Codex configuration, prompt policy, and diagnostics

These integrations are explicit and reversible. A normal plugin or skills-only
install does not change `PATH`, launchd, Docker state, or active Container Lab
state.

## Maintainer workflow

Change canonical packages or skills, never `plugins/skizzles/` directly. Use:

```sh
just plugin-build
just plugin-check
just verify
```

`plugin-build` regenerates the distribution tree. `plugin-check` proves that
the generated tree matches its canonical inputs. Inspect the generated diff
before handing off a packaging change.
