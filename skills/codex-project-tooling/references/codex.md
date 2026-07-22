# Repo-local `.codex` configuration

Use repo-local Codex configuration for hooks, roles, skills, and conventions that should travel with a repository. This reference is for maintainers deciding what belongs under `.codex`, how trust affects loading, and how Codex Desktop linked worktrees resolve project tooling.

Before editing, inspect the current `.codex` tree, confirm the repository is trusted where privileged project behavior is required, and separate shared policy from personal `$CODEX_HOME` preferences.

## Workflow

1. Classify the requested behavior as shared project policy or user-local preference.
2. Add only the required `.codex` files and use repo-relative paths between committed files.
3. Document the trusted-project requirement for hooks, roles, config, or MCP servers.
4. Check linked-worktree resolution when Desktop sessions are part of the workflow.
5. Parse the configuration and exercise the changed surface in a fresh trusted thread.

## Layout

```text
.codex/
  config.toml
  hooks.json
  hooks/
    check-shell.py
  agents/
    triage.toml
    reviewer.toml
  skills/
    project-skill/
      SKILL.md
```

Use only the pieces the project needs. Avoid committing local credentials, machine-specific paths, and experimental scratch files.

## Project config

`.codex/config.toml` can define repo-local features, hooks, agents, permissions, MCP settings, and other normal Codex config. Prefer relative paths for files committed in the repo:

```toml
[features]
hooks = true
multi_agent = true
goals = true

[agents]
max_threads = 6
max_depth = 1

[agents.reviewer]
description = "Use for adversarial review of completed changes."
config_file = ".codex/agents/reviewer.toml"
```

Keep repo config focused on shared project behavior. Put personal preferences in the user-level `$CODEX_HOME/config.toml`, not in the repository.

## Trust boundary

Project config, hooks, and agent roles are gated by trusted project layers. A repo generally must be trusted before its project `.codex/config.toml`, hooks, and role definitions affect sessions.

Skills are more discoverable than other project configuration: repo-local skill roots may be available even when other project layers are disabled. Do not rely on this exception for privileged behavior; put privileged automation behind trusted hooks/config instead.

When authoring project tooling, document whether the user must trust the project before the change works.

## Desktop linked worktrees

Codex Desktop can spawn sessions in linked worktrees. In linked worktrees:

- Trust resolves back through the `.git` file to the root repository identity.
- Worktree-local checked-out `.codex/config.toml`, `.codex/agents`, and `.codex/skills` come from the worktree contents.
- Hook declarations are special-cased to use the matching root checkout `.codex` hook declarations instead of divergent worktree hook declarations.

If a project relies on hooks, update and trust the root checkout behavior. If it relies on roles or config, make sure the worktree branch contains the intended `.codex` files.

## Commit boundary

Commit when the behavior is durable and project-relevant:

- Role definitions for recurring project responsibilities.
- Hook scripts that enforce repo conventions.
- Skills that encode project domain knowledge.
- Config needed for build reproducibility or safe agent orchestration.

Keep local-only when the behavior is personal or sensitive:

- Credentials and tokens.
- Absolute paths outside the repo.
- Temporary experiments.
- User-specific model/provider choices unless the role intentionally locks them.

## Verification

- Parse TOML/JSON after edits.
- Confirm referenced files exist and use relative paths when committed.
- Confirm role files define required metadata.
- Confirm hook scripts are executable through their configured command.
- Confirm trusted-project expectations are documented in the final response.
- In a linked worktree, confirm whether the relevant behavior comes from root checkout hooks or worktree config/agents.
