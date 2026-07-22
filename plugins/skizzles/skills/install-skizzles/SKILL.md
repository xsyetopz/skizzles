---
name: install-skizzles
description: Choose, install, diagnose, update, or uninstall Skizzles from its canonical repository. Use when a user wants plain Codex skills, the complete Skizzles plugin harness, source-linked development, or help making a new task pick up an installed version.
---

# Install Skizzles

Choose and manage one of three installation surfaces: the full plugin,
skills-only guidance, or the private source-linked installer. This skill is for
users who want to install, update, diagnose, or remove Skizzles.

## Before changing host state

- Get explicit approval before mutating a live Codex home, plugin marketplace,
  `PATH`, Docker, or launchd.
- Resolve the target Codex home and Codex executable as absolute paths.
- Decide whether the user needs hooks and runtime tools, skills only, or a
  receipt-backed source lifecycle.
- Use disposable roots for probes and demonstrations.

## Choose the installation surface

- Use the full plugin when the user wants Skizzles skills, hooks, and bundled
  runtime tools.
- Use skills-only mode when the user wants guidance without hooks or runtime
  helpers.
- Use the private source installer only for source-linked development,
  explicit Codex configuration, or prompt-policy work.

Do not describe the private source installer as the official Codex
plugin/marketplace flow. They own different state and have different removal
rules.

## Install the full plugin

From a Skizzles checkout, run:

```sh
just plugin-install /absolute/path/to/codex-home
```

The recipe adds the checkout as the `skizzles` marketplace and installs
`skizzles@skizzles`. It requires an existing absolute `CODEX_HOME` target and
does not create one implicitly. Set `CODEX_BIN=/absolute/path/to/codex` when
the Codex executable is not on `PATH`.

Without a checkout, use the official Codex CLI flow with the repository as a
Git marketplace, then install `skizzles@skizzles`. Confirm the exact syntax in
the current [plugin](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-plugin)
and [marketplace](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-plugin-marketplace)
command reference. For an explicit target, set `CODEX_HOME` on both commands:

```sh
CODEX_HOME=/absolute/path/to/codex-home codex plugin marketplace add xsyetopz/skizzles
CODEX_HOME=/absolute/path/to/codex-home codex plugin add skizzles@skizzles
```

Check or remove a receipt-free plugin install from a checkout with:

```sh
just plugin-status /absolute/path/to/codex-home
just plugin-remove /absolute/path/to/codex-home
```

Removal removes only `skizzles@skizzles` and the configured `skizzles`
marketplace, in that order. Start a new Codex task after installation,
removal, or an update; the current task does not hot-reload a plugin cache.

## Install skills only

From a checkout, run:

```sh
just skills-install
```

The equivalent direct command is `bunx skills add
https://github.com/xsyetopz/skizzles --skill install-skizzles`. Skill-only mode
does not activate hooks or change Codex configuration.

## Use the private source lifecycle

Use the private installer only after the user has chosen explicit target roots,
the link/copy behavior, and the lifecycle they want. Preview every stateful
operation first with `--dry-run`, review its targets, then repeat the same
command without the flag. Run its help from the selected source checkout:

```sh
bun run packages/installer/src/cli.ts --help
```

The installer owns receipt-backed skills/harness transfers, Codex
orchestration configuration, and prompt-policy apply/restore. It requires
absolute roots and an absolute Codex binary for configuration or prompt policy.
It fails closed on foreign or drifted targets; never delete a receipt to force
an uninstall or restoration.

Prompt policy is an independent opt-in lifecycle. It replaces the complete
managed values as one policy and must never be applied implicitly by a plugin
or skills install. Start a new Codex session after applying or restoring it.

## Optional host tools

Container Lab and the Luna model catalog are separate, explicit host setup.
Read the owning guides from a source checkout or full plugin snapshot before
editing `PATH`, loading launchd, or changing a model catalog:

- `packages/container-lab/docs/installation.md`
- `packages/model-catalog/docs/installation.md` (or the packaged asset)

Keep health probes and demonstrations on disposable roots. An installed bundle
with an unavailable Docker daemon is not proof that Container Lab is broken.

## Boundaries

- A dry run or repository packaging check does not activate an installation.
- Do not delete a private-installer receipt to bypass drift or ownership checks.
- Do not apply prompt policy as a side effect of plugin or skills installation.
- Do not treat plugin installation, source installation, and optional host-tool
  setup as interchangeable lifecycles.
- A running task does not hot-reload an installed or updated plugin cache.

## Verification and report

Use `just plugin-status /absolute/path/to/codex-home` for a checkout-managed full
plugin. For a private-installer lifecycle, use its status or dry-run surface and
confirm the receipt remains available. Verify skill-only installs from a new
task, because skill discovery is session-bound.

Tell the user what was installed, updated, or removed; which target changed;
whether files were linked or copied; and where a private-installer receipt
lives. Report optional host wiring separately. Start a new Codex task to verify
discovery after installation or update.
