---
name: codex-project-tooling
description: Author and maintain repo-local Codex project tooling. Use when configuring project-level .codex/config.toml, hooks, subagent roles under .codex/agents, repo-local MCP servers, Bun/FastMCP scaffolding, paired MCP skills, trusted-project behavior, linked worktree behavior, or repo-specific Codex automation conventions.
---

# Codex project tooling

Configure Codex behavior that belongs to a repository rather than one user. This skill is for maintainers adding or changing project-level `.codex` configuration, hooks, subagent roles, MCP servers, or paired MCP skills.

## Before you edit

- Read the repository instructions and inspect its existing `.codex` tree.
- Confirm which behavior is shared project policy and which belongs in a user's `$CODEX_HOME`.
- Check whether trusted-project or linked-worktree behavior affects the requested setup.
- Keep credentials, machine paths, and temporary experiments out of committed files.

## Reference map

Read the relevant reference before editing:

- [Hooks](references/hooks.md)
- [Subagent roles](references/subagent-roles.md)
- [MCP authoring with Bun and FastMCP](references/mcp/authoring.md)
- [Codex MCP client behavior and config](references/mcp/client.md)
- [Companion skills for MCP servers](references/mcp/skills.md)
- [MCP-managed environment stacks](references/mcp/lifecycle.md)
- [Project `.codex`, trust, and worktrees](references/codex.md)

## Workflow

1. Classify the change as hooks, roles, MCP, project loading, or a combination.
2. Read the matching reference and trace existing declarations before adding files.
3. Make the smallest reviewable repo-local change that expresses the intended team behavior.
4. Document any trust, worktree, approval, or lifecycle requirement next to the setup it affects.
5. Run the narrowest syntax check, then exercise the changed surface through Codex when practical.

## Design rules

- Keep hook commands deterministic, non-interactive, and bounded by timeouts.
- Keep subagent role descriptions short but operational: say when to use the role, what it owns, and what it must avoid.
- Prefer stdio Bun/FastMCP servers for repo-local MCP tooling.
- Omit `cwd` for repo-local MCP servers so Codex starts them in each task's workspace. Set `cwd` only when the server intentionally uses a fixed absolute directory; never use `cwd = "."`.
- Pair nontrivial MCP servers with a skill that explains when to use the tools and how to interpret outputs.
- Use relative paths inside repo-local config when the file lives in the repo.
- Treat project tooling as shared infrastructure. Commit one-off scripts only after they become stable, documented project assets.
- When Codex Desktop worktrees are involved, confirm how `.codex` files and hooks resolve before assuming a worktree has different project tooling from the root checkout.

## Verification and report

Parse changed TOML, JSON, and YAML. Confirm every referenced path exists. Then use the smallest relevant runtime check: list hooks, spawn a role with a safe prompt, run `bun run validate:stdio`, or call a harmless MCP health tool from a fresh trusted thread.

When adding or changing project tooling, summarize:

- Files changed.
- Which hooks, roles, MCP servers, or paired skills are now available.
- How trust/worktree behavior affects the setup.
- How the change was validated.
