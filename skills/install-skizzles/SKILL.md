---
name: install-skizzles
description: Choose, install, diagnose, update, or uninstall Skizzles from its canonical repository. Use when a user wants plain Codex skills, the complete Skizzles plugin harness, source-linked hot reload, an isolated copied install, optional Container Lab compatibility checks, or help making a new task pick up an installed version.
---

# Install Skizzles

Keep installation deliberate and reversible. Never mutate a live Codex home, plugin marketplace, `PATH`, Docker, or launchd without the user's explicit approval.

## Choose the installation

- Use plain-skill mode when the user only wants skills. It manages selected directories below an explicit `CODEX_HOME/skills` and never activates hooks or runtime helpers.
- Use full-harness mode only when the user wants the generated Skizzles plugin and accepts that its hooks may become available through the target marketplace.
- After the complete plugin surface is installed, choose `passive` orchestration to enable hooks without overriding Codex's native MultiAgentV2 defaults, or `aggressive` orchestration to activate proactive Fourth Wall routing.
- Use `link` for a trusted local checkout that should hot-reload source updates. Use `copy` for an isolated snapshot.
- Prefer a versioned release checkout for stable use. Treat `plugins/skizzles` as generated output and build it before a full-harness install.

Confirm the source checkout, absolute target `HOME`, absolute target `CODEX_HOME`, surface, and transfer method before running a non-dry-run command. Use temporary targets for demonstrations and validation. The current skills surface installs every public skill as one owned set.

The complete plugin bundles the installer at `packages/installer/`; run the commands below from the plugin root or a selected source checkout. If this skill was installed by itself with the Skills CLI, do not assume that package exists beside it. Ask the user to select a Skizzles release or commit, obtain and verify that versioned checkout, then run the installer from its root.

## Run the lifecycle

From the selected Skizzles checkout, preview first:

```sh
bun run packages/installer/src/cli.ts install \
  --source-root /absolute/path/to/skizzles \
  --codex-home /absolute/target/codex-home \
  --surface skills --transfer link --dry-run
```

For an isolated source-linked development harness, build and check `plugins/skizzles` first, then preview the custom harness surface against an explicit disposable home:

```sh
bun run packages/installer/src/cli.ts install \
  --source-root /absolute/path/to/skizzles \
  --home /absolute/target/home \
  --surface harness --transfer link --dry-run
```

Run the preview again without `--dry-run` only after reviewing its exact targets. Diagnose or remove the receipt-owned install with the same explicit roots:

```sh
bun run packages/installer/src/cli.ts doctor --home /absolute/target/home --codex-home /absolute/target/codex-home
bun run packages/installer/src/cli.ts uninstall --surface skills --codex-home /absolute/target/codex-home --dry-run
bun run packages/installer/src/cli.ts uninstall --surface harness --home /absolute/target/home --dry-run
```

The custom harness surface is for isolated development and test fixtures. Install, update, or uninstall a stable versioned plugin through the official Codex plugin/marketplace flow instead; plugin installs are cached snapshots and a new task may be required. The installer fails closed on foreign targets. Skills receipts live below `CODEX_HOME/.skizzles/`; harness receipts live below `HOME/.skizzles/`. Uninstall verifies receipt-listed links or copied content and restores the exact marketplace state it owned. Do not bypass conflicts by deleting or overwriting paths for the user.

## Complete the Codex configuration

Only run this lifecycle after the complete plugin surface—and therefore its packaged hook—has been installed. It is independent from skill/plugin file transfer so a user can change machine policy without reinstalling content.

Ask the user to choose an orchestration mode:

- `passive` writes only `features.hooks = true`. It does not write any MultiAgentV2 setting or hint, so Codex retains its model-specific native defaults.
- `aggressive` also enables MultiAgentV2, sets `max_concurrent_threads_per_session = 7`, adds one concise proactive mode hint, and gives roots and subagents short pointers to `$fourth-wall`. Use this only when the user wants autonomous quality-and-speed delegation.

Preview against an explicit `CODEX_HOME` and absolute Codex binary:

```sh
bun run packages/installer/src/cli.ts configure \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex \
  --orchestration aggressive --dry-run
```

Review the reported key list, then repeat without `--dry-run`. Restore the exact prior values with:

```sh
bun run packages/installer/src/cli.ts unconfigure \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex --dry-run
```

Repeat restoration without `--dry-run` only after previewing it. Preview launches that Codex binary's app-server against a disposable isolated config snapshot and leaves the selected `CODEX_HOME` byte-for-byte and entry-for-entry unchanged. Required relative read inputs named by the selected config are privately copied only when they remain inside the selected home and traverse no symlink; resolved preview paths are reported as their selected-home equivalents, and the snapshot is removed after use. Non-preview operations launch the app-server against the selected home and use native `config/read` plus atomic `config/batchWrite` with version-conflict detection. The receipt lives at `CODEX_HOME/.skizzles/config-receipt.json`; restoration fails closed if an owned value drifted. This orchestration lifecycle never edits `AGENTS.md`, `developer_instructions`, approvals, permissions, goals, model defaults, MCP registrations, or unrelated feature flags. Do not manually delete the receipt to bypass a conflict.

## Apply the optional prompt policy

Prompt policy is separate from installation and orchestration configuration. Never run it implicitly. It replaces three complete values as one policy: `model_instructions_file`, `developer_instructions`, and `compact_prompt`. It does not concatenate unknown personal text.

Preview from the selected source checkout or plugin snapshot with explicit roots and an absolute Codex binary:

```sh
bun run packages/installer/src/cli.ts prompt-policy apply \
  --source-root /absolute/path/to/selected/skizzles \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex --dry-run
```

Review the prior-presence flags, digests, byte counts, managed-target classification, and planned action. The summary deliberately omits prior personal prompt text and replacement bodies. Preview launches the selected app-server only against a disposable owner-only copy of the selected config and its validated in-home relative read inputs, remaps resolved paths to selected-home values, removes the snapshot, and leaves the selected `CODEX_HOME` byte-for-byte and entry-for-entry unchanged. Escaping, symlinked, oversized, or changed-during-copy relative inputs fail closed. Repeat without `--dry-run` only after explicit approval.

Apply validates the portable descriptor, every policy digest, the generic-base provenance relationship, and the bundled OpenAI `LICENSE` and `NOTICE`. It copies the applied base to `CODEX_HOME/.skizzles/prompt-policy/skizzles-base.md` with owner-only permissions before atomically writing all three config values through the selected Codex app-server. The separate receipt is `CODEX_HOME/.skizzles/prompt-policy-receipt.json`.

Preview exact restoration with:

```sh
bun run packages/installer/src/cli.ts prompt-policy restore \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex --dry-run
```

Restoration proceeds only when the selected binary and config path match the receipt, all three current values equal the recorded replacements, and the managed prompt digest is unchanged. It then atomically restores each exact prior value, deleting only values that were originally absent. One identity-bound lifecycle lock serializes apply, resume, restore, and interrupted-state cleanup. Only the exact current app-server wire value `error.data.config_write_error_code = "configVersionConflict"` is treated as a confirmed pre-write conflict that can clean newly created apply evidence. The other current `ConfigWriteErrorCode` values remain redacted protocol rejections; missing, legacy-shaped, unknown, timeout, and closed-transport outcomes retain pending or restoring evidence. Drift retains evidence; do not bypass it by manual deletion.

Start a new Codex session after applying or restoring because existing conversation history can retain earlier instructions. `compact_prompt` controls local history compaction only; provider-managed remote compaction may bypass it. Do not claim activation from installation, a dry run, or repository packaging alone.

## Use Container Lab deliberately

A skill-only installation contains Container Lab guidance and its launcher, not the runnable CLI. Its launcher uses a distinct installed `codex-container-lab` PATH binary when one exists; otherwise it exits with a compact instruction to obtain the full Skizzles plugin or source checkout. The stable Skizzles plugin includes the dependency-self-contained operational and reaper bundles; a selected source checkout includes the canonical workspace package.

Use the `scripts/codex-container-lab` launcher beside the public `codex-container-lab` skill before relying on any `PATH` command. `doctorContainerLab` reports only the optional PATH convenience; bundled ownership paths and source provenance come from `integrations/container-lab.json`. Host PATH and LaunchAgent activation remain explicit, reversible wiring, not part of a skill-only or plugin install.

Read the canonical [Container Lab installation and optional host-wiring guide](../../packages/container-lab/docs/installation.md) from a source checkout. Plugin snapshots carry the guide under `packages/container-lab/docs/installation.md`. Keep doctor health probes on disposable owner/state/runtime roots. Never wrap an attached `run`, invoke live reaping, edit `PATH`, or load launchd as part of a skill/plugin install; host wiring is separate, explicit, reversible, and machine-local.

An installed bundle with an unavailable Docker daemon is `installed-not-ready`, not proof that Container Lab is broken. The configured `0.1.0` compatibility is unverified until a release fingerprint is supplied.

## Enable the optional Luna V2 catalog

The source workspace owns the model overlay in `packages/model-catalog`; generated plugins expose its bundled executable at `runtime/model-catalog.ts` and its LaunchAgent template under `assets/`. This is explicit host wiring for owners who have independently verified Luna with MultiAgentV2, not part of ordinary skill/plugin installation.

Read `packages/model-catalog/docs/installation.md` in a source checkout or `assets/model-catalog-installation.md` in a plugin snapshot. The generator preserves the full upstream model catalog and changes only `gpt-5.6-luna.multi_agent_version` from `v1` to `v2`. It never reads or copies credentials. It accepts only a fresh, version-matched, complete `CODEX_HOME/models_cache.json`, otherwise uses the selected Codex binary's bundled catalog, and preflights the result through that binary before promotion.

Render and validate the LaunchAgent before loading it, then set the global `model_catalog_json` to the generated absolute path. A generated catalog is applied only at app-server startup; restart app-server after a refresh reports `catalogChanged: true`. The status `generation` is the stable catalog identity, while `catalogChanged` describes only its most recent refresh. Do not restart Desktop or app-server automatically while tasks are active. If upstream already marks Luna V2, the overlay reports `upstream-v2` and leaves that field unchanged.

## Finish on a new task

Tell the user what was installed, whether it was linked or copied, and where the receipt lives. Start a new Codex task after install or update so the selected skills and hooks are discovered cleanly; never claim the current task hot-reloaded them.
