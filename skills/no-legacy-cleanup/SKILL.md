---
name: no-legacy-cleanup
description: Remove obsolete behavior, tooling, docs, config, tests, scripts, flags, generated artifacts, wrappers, aliases, compatibility paths, and tombstones cleanly. Use when replacing an old system, deleting old harnesses, renaming/removing entrypoints, migrating configs, or preventing legacy code from surviving as disabled or documented leftovers.
---

# No-legacy cleanup

Remove an obsolete system completely after its replacement or deletion has been approved. This skill is for maintainers cleaning code, config, tests, docs, scripts, generated output, and user-facing entrypoints. The final state has one supported path.

## Before removal

- Confirm the user wants removal or replacement, not a compatibility period.
- Identify the approved replacement when one exists.
- Search for old names, aliases, files, commands, routes, config keys, and generated artifacts before editing.
- Check repository ownership rules for generated files and distribution output.

## Removal boundary

Do not preserve obsolete behavior through:

- compatibility wrappers
- aliases
- disabled entrypoints
- hard-error stubs
- tombstone files
- deprecated-but-available routes
- fallback behavior
- old command names
- stale tests
- stale docs
- comments explaining removed paths
- config keys that reserve old names
- generated artifacts from the old path
- UI affordances that still advertise the old behavior

Do not interpret removal as "hard-disable but keep discoverable" unless the user explicitly asks for a compatibility period.

## Workflow

1. Identify the old names, entrypoints, scripts, routes, config keys, docs, tests, and generated artifacts.
2. Replace behavior through the approved new path.
3. Delete obsolete artifacts rather than redirecting to them.
4. Search for old names and references with `rg`.
5. Update tests and docs only when they describe the new behavior or remain an active source of truth.
6. Rebuild generated output from canonical sources when the repository requires it.
7. Run focused behavior checks, then search again for the old names and paths.

## Verification

Before reporting completion, answer these questions from repository evidence:

- Can a user, agent, script, config, or test still invoke the old path?
- Does any doc or comment still teach the old workflow?
- Did a stale test preserve legacy behavior instead of validating the new contract?
- Is there a compatibility shim the user did not request?
- Do generated artifacts still reflect the old schema or path?
- Does any "temporarily disabled" code remain?

Report removed paths, focused validation, old-name search results, and every intentionally retained artifact. If an explicit user decision requires a legacy artifact, state that decision and keep the retained surface as narrow as possible.
